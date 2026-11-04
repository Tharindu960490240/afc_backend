const bcrypt = require("bcryptjs");
const env = require("../config/env");

const hashPassword = (plain) => bcrypt.hash(plain, env.bcryptRounds);
const comparePassword = (plain, hash) => bcrypt.compare(plain, hash);

// Used when the email is unknown, so login takes about the same time either way.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", env.bcryptRounds);

module.exports = { hashPassword, comparePassword, DUMMY_HASH };
