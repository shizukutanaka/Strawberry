// ユーザーテーブル作成マイグレーション
exports.up = function(knex) {
  return knex.schema.createTable('users', function(table) {
    table.uuid('id').primary();
    table.string('username').notNullable().unique();
    table.string('email').notNullable().unique();
    table.string('password').notNullable();
    table.string('role').notNullable().defaultTo('user');
    table.string('apiKey').unique();
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
    table.timestamp('lastLogin');
    table.json('settings');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('users');
};
