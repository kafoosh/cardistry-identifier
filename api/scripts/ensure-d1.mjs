// Finds the "cardistry" D1 database on the Cloudflare account (creating it on
// first run) and writes its id into wrangler.toml, so deploys need no
// hand-edited ids. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const NAME = 'cardistry'
const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8' })

const find = () => JSON.parse(wrangler('d1', 'list', '--json')).find((d) => d.name === NAME)

let db = find()
if (!db) {
  console.log(`Creating D1 database "${NAME}"`)
  wrangler('d1', 'create', NAME)
  db = find()
}
if (!db) throw new Error('D1 database not found after create')
const id = db.uuid ?? db.id
const toml = readFileSync('wrangler.toml', 'utf8').replace(/database_id = "[^"]*"/, `database_id = "${id}"`)
writeFileSync('wrangler.toml', toml)
console.log(`Using D1 database ${NAME} (${id})`)
