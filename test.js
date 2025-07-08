const { signUp, signIn } = require('./auth');

async function testAuth() {
  await signUp('trial', 'trial@example.com', 'trial123');
  const success = await signIn('trial@example.com', 'trial123');
  console.log('Sign-in result:', success);
}

testAuth();
