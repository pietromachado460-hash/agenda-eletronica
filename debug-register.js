const http = require('http');
const data = JSON.stringify({ nome:'Teste', telefone:'11999999999', senha:'123456', confirmSenha:'123456' });
const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/auth/register',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};
const req = http.request(options, (res) => {
  console.log('STATUS', res.statusCode);
  console.log('HEADERS', JSON.stringify(res.headers));
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log('BODY', body));
});
req.on('error', (err) => console.error('ERR', err.message));
req.write(data);
req.end();
