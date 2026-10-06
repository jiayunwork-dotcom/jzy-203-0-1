const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPg } = require('./embeddedPg');

const INFO_FILE = path.join(__dirname, '.embedded-pg.json');

module.exports = async () => {
  const info = await startEmbeddedPg();
  fs.writeFileSync(INFO_FILE, JSON.stringify(info));
  process.env.LCURVE_TEST_DATABASE_URL = info.url;
};
