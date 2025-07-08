const oracledb = require('oracledb');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const dbConfig = {
  user: 'ADMIN',
  password: 'admin',
  connectString: 'localhost:1521/orcl'
};

async function getConnection() {
  try {
    const connection = await oracledb.getConnection(dbConfig);
    console.log('✅ Oracle DB Connected Successfully!');
    return connection;  // Return the open connection
  } catch (err) {
    console.error('❌ DB Connection Failed:', err);
    throw err;
  }
}

module.exports = { getConnection };
