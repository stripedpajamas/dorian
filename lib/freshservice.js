const url = require('url');

module.exports = function (host, apiKey, method, resource, data) {
  return {
    url: url.resolve(host, resource),
    method,
    auth: {
      user: apiKey,
      pass: 'dummy',
    },
    body: data || '',
    json: true,
  };
};
