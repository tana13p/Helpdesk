const { getConnection } = require('./dbconfig');
const bcrypt = require('bcrypt');

// SIGN UP FUNCTION
async function signUp(username, email, password) {
  const connection = await getConnection();
  try {
    const role_id = 3; // Default role ID for new users, adjust as needed
    const password_hash = await bcrypt.hash(password, 10);

    const result = await connection.execute(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES (:username, :email, :password_hash, :role_id)`,
      { username, email, password_hash, role_id },
      { autoCommit: true }
    );

    console.log('✅ User registered successfully!');
  } catch (err) {
    console.error('❌ Sign-up error:', err);
  } finally {
    await connection.close();
  }
}

// SIGN IN FUNCTION
async function signIn(email, password) {
  if (!email || !password) {
    console.log('signIn called without email or password');
    return { success: false, message: 'Missing email or password' };
  }
  const connection = await getConnection();
  try {

    const result = await connection.execute(
      `SELECT username, password_hash, role_id, user_id FROM users WHERE LOWER("EMAIL") = LOWER(:EMAIL)`,
      { email: email }
    );

    console.log('🔍 Query result:', result.rows);

    if (result.rows.length === 0) {
      console.log('❌ User not found');
      return { success: false, message: 'User not found' };
    }

    const storedHash = result.rows[0].PASSWORD_HASH;
    const storedRoleId = result.rows[0].ROLE_ID;
    const userId = result.rows[0].USER_ID;
    const username = result.rows[0].USERNAME;


    const match = await bcrypt.compare(password, storedHash);
    if (!match) {
      console.log('❌ Incorrect password');
      return { success: false, message: 'Incorrect password' };
    }

    console.log('✅ Login successful!');
    return { success: true, message: 'Login successful', role_id: storedRoleId, user_id: userId, username: username };
    // After verifying user credentials

  } catch (err) {
    console.error('❌ Sign-in error:', err);
    return { success: false, message: 'Internal server error' };
  } finally {
    await connection.close();
  }
}
module.exports = { signIn, signUp };
