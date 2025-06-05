// oauth.js - OAuth認証（Google, GitHub）ミドルウェア
// Passport.jsを用いてGoogle/GitHub OAuthログインを簡単に統合

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const { logger } = require('./logger');

// ユーザー情報の永続化は必要に応じて拡張
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Google OAuth2
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL,
}, (accessToken, refreshToken, profile, done) => {
  logger.info('Google OAuth login', { id: profile.id, name: profile.displayName });
  // 必要に応じてユーザーDB登録・JWT発行
  return done(null, profile);
}));

// GitHub OAuth2
passport.use(new GitHubStrategy({
  clientID: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  callbackURL: process.env.GITHUB_CALLBACK_URL,
}, (accessToken, refreshToken, profile, done) => {
  logger.info('GitHub OAuth login', { id: profile.id, name: profile.displayName });
  // 必要に応じてユーザーDB登録・JWT発行
  return done(null, profile);
}));

module.exports = passport;
