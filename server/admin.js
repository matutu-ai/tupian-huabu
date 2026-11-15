// Usage: node server/admin.js grant <email> <credits> [note]
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const db = new DatabaseSync(process.env.DB_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data.db'));
const [cmd, email, amt, ...note] = process.argv.slice(2);
if (cmd !== 'grant' || !email || !Number.isInteger(+amt)) { console.log('node server/admin.js grant <email> <credits> [note]'); process.exit(1); }
const u = db.prepare('SELECT id,credits FROM users WHERE email=?').get(email.toLowerCase());
if (!u) { console.log('用户不存在'); process.exit(1); }
if (u.credits + +amt < 0) { console.log('余额不能为负'); process.exit(1); }
db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(+amt, u.id);
db.prepare('INSERT INTO ledger(user_id,ts,delta,note) VALUES(?,?,?,?)').run(u.id, Date.now(), +amt, note.join(' ') || '管理员调整');
console.log('完成，当前余额', u.credits + +amt);
