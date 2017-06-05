/**
 * Created by petersquicciarini on 6/4/17.
 */

const winston = require('winston');

if (!process.env.slackClientID || !process.env.slackClientSecret ||
  !process.env.ticketSystemUrl || !process.env.PORT || !process.env.mongoUri ||
  !process.env.ticketSystemAPIKey || !process.env.dattoAPIKey) {
  winston.log('error', 'Please see README for required env vars.');
  process.exit(1);
}

const Botkit = require('./lib/botkit');
const express = require('express');
const bodyParser = require('body-parser');
const mongoStorage = require('botkit-storage-mongo')({mongoUri: process.env.mongoUri});
const url = require('url');
const freshservice = require('./lib/freshservice');
const request = require('request');
const events = require('events');
const eventEmitter = new events.EventEmitter();

const connectionInfo = {
  slackClientID: process.env.slackClientID,
  slackClientSecret: process.env.slackClientSecret,
  ticketSystemUrl: process.env.ticketSystemUrl,
  ticketSystemAPIKey: process.env.ticketSystemAPIKey,
};
const controller = Botkit.slackbot({
  storage: mongoStorage,
  debug: false,
}).configureSlackApp({
  clientId: connectionInfo.slackClientID,
  clientSecret: connectionInfo.slackClientSecret,
  scopes: ['bot', 'channels:read', 'users:read'],
});

// setup webserver

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname + '/public'));
app.listen(process.env.PORT, () => {
  winston.log(`** Starting webserver on port ${process.env.PORT}`);
});

controller.createWebhookEndpoints(app);
controller.createHomepageEndpoint(app);
controller.createOauthEndpoints(app, (err, req, res) => {
  if (err) {
    res.status(500).send(`ERROR: ${err}`);
  } else {
    res.send('Success!');
  }
});

app.post('/datto', (req, res) => {
  if (req.body && req.body.authentication && req.body.authentication === process.env.dattoAPIKey) {
    eventEmitter.emit('dattoAlert', req.body && req.body.dattoalert);
  }
  res.send('Thanks!');
});

// just a simple way to make sure we don't
// connect to the RTM twice for the same team
const activeBots = {};
function trackBot(bot) {
  activeBots[bot.config.token] = bot;
}

controller.on('create_bot', (bot) => {
  if (activeBots[bot.config.token]) {
    // already online! do nothing.
  } else {
    bot.startRTM((err) => {
      if (!err) {
        trackBot(bot);
      }
    });
  }
});

controller.storage.teams.all((err, teams) => {
  if (err) {
    throw new Error(err);
  }
  // connect all teams with bots up to slack!
  Object.keys(teams).forEach((t) => {
    if (teams[t].bot) {
      controller.spawn(teams[t]).startRTM((startErr, bot) => {
        if (startErr) {
          winston.log('error', 'Could not connect to Slack RTM.');
        } else {
          trackBot(bot);
        }
      });
    }
  });
});

controller.on('rtm_open', (bot) => {
  winston.log('info', '** The RTM api just connected!');

  eventEmitter.on('dattoAlert', (alert) => {
    bot.api.channels.list({}, (err, response) => {
      if (response.hasOwnProperty('channels') && response.ok) {
        const alertsChannel = response.channels.find(ch => ch.name === 'alerts');
          // Handle listening for Zapier webhook'd Datto event here and replying
            const msgTemplate = {
              username: 'dorian',
              icon_emoji: ':panda_face:',
              channel: alertsChannel.id,
              color: 'danger',
              text: 'Datto Alert Received', // text from webhook will go here
              attachments: [
                {
                  fallback: alert,
                  callback_id: 'alertResponse',
                  title: alert,
                  actions: [
                    {
                      name: 'reset',
                      text: 'Reset Alert',
                      value: 'reset',
                      type: 'button'
                    },
                    {
                      name: 'ticket',
                      text: 'Create ticket',
                      value: 'ticket',
                      type: 'button'
                    }
                  ],
                },
              ],
            };
            bot.say(msgTemplate);
      }
    });
  });
});

controller.on('rtm_close', (bot) => {
  winston.log('warn', '** The RTM api just closed');
  bot.startRTM((err) => {
    if (!err) {
      trackBot(bot);
    }
  });
});

controller.on('interactive_message_callback', function(bot, message) {
  bot.api.users.info({user: message.user}, function(err, info){
    var buttonPresser = null;
    if (err) {
      winston.log('error: ** could not get user name of button presser');
    } else {
      buttonPresser = info.user.name;
    }
    if (message.actions[0].value === 'reset') {
      bot.replyInteractive(message, {
        attachments: [
          {
            fallback: 'Alert reset',
            text: message.original_message.attachments[0].title,
            color: 'good',
            fields: [{
              title: `Alert has been reset${buttonPresser ? ' by ' + buttonPresser : '!'}`
            }],
          }
        ]
      });
    } else if (message.actions[0].value === 'ticket') {
      const ticketObject = {
        helpdesk_ticket: {
          description: message.original_message.attachments[0].title,
          subject: message.original_message.attachments[0].title,
          email: 'noreply@dattobackup.com',
          priority: 1,
          status: 2,
          source: 2,
          ticket_type: 'Incident',
        }
      };
      const fs_host = process.env.ticketSystemUrl;
      request(freshservice(fs_host, process.env.ticketSystemAPIKey, 'POST', '/helpdesk/tickets.json', ticketObject), function(err, res, body) {
        winston.log('info: ** Sending new ticket request to FreshService');
        if (err) {
          winston.log('error: ** Ticket creation failed:', err);
        }
        if (typeof body === 'object' && body.status) {
          bot.replyInteractive(message, {
            attachments: [
              {
                fallback: 'Ticket created',
                text: message.original_message.attachments[0].title,
                color: 'good',
                fields: [{
                  title: `Alert made into a ticket${buttonPresser ? ' by ' + buttonPresser : '!'}`,
                  value: 'https://' + fs_host + '/helpdesk/tickets/' + body.item.helpdesk_ticket.display_id
                }],
              }
            ]
          });
        }
      })
    }
  });
});