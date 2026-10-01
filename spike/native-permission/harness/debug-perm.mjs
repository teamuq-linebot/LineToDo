// Debug: with the permission model active, print permission.has for the install/data dirs
// in both backslash and forward-slash form. argv[2]=installDir(backslash), argv[3]=dataDir.
const p = process.permission
const install = process.argv[2]
const data = process.argv[3]
const toFwd = (s) => s.split('\\').join('/')
console.log(JSON.stringify({
  install_backslash: p.has('fs.read', install),
  install_fwd: p.has('fs.read', toFwd(install)),
  data_backslash_read: p.has('fs.read', data),
  data_fwd_read: p.has('fs.read', toFwd(data)),
  data_write: p.has('fs.write', data),
}, null, 2))
