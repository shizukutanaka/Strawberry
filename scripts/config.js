require('dotenv').config();
module.exports = {
  API_ENDPOINT: process.env.API_ENDPOINT || 'https://api.example.com',
  TIMEOUT_MS: 3000,
  DEFAULT_LANG: process.env.LANG || 'ja'
};
