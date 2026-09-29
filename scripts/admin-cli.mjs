#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge, bridgeHeaders } from './telemetry-service.mjs';
import { resolveCliConfig } from './circuit-test-cli.mjs';
import { ProjectLock } from './project-lock.mjs';
import { AdminService } from './admin-service.mjs';

// JSON files preserve command quoting and keep credentials out of arguments.
export async function main(argv) {
  if(argv.length!==1 || argv[0]==='--help') {
    process.stdout.write('Usage: node scripts/admin-cli.mjs status | request.json\nRequest: {"action":"tick","operation":"rate","rate":100,"expected_session":"UUID","expected_world":"World name"}\nActions: status, tick, command. See docs/COMMAND_CENTRE.md.\n');
    return argv[0]==='--help'?0:1;
  }
  const config=resolveCliConfig({});
  const state=join(config.project,'.minecraft-assistant');
  const bridge=new Bridge(undefined,{headersProvider:s=>bridgeHeaders(s,config.configDir?{MINECRAFT_MCP_CONFIG_DIR:config.configDir}:{})});
  try {
    let input={action:'status'};
    if(argv[0]!=='status') {
      const raw=readFileSync(resolve(argv[0]));
      if(raw.length>16384) throw new Error('Admin request exceeds 16 KiB.');
      input=JSON.parse(raw.toString('utf8'));
    }
    const service=new AdminService(bridge,{stateDir:join(state,'admin'),lock:new ProjectLock(state)});
    const result=input.target==='client'?await service.client((({target,...v})=>v)(input)):await service.run(input);
    process.stdout.write(result.content[0].text+'\n');
    return JSON.parse(result.content[0].text).success===false?2:0;
  } finally {await bridge.close();}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.exitCode=await main(process.argv.slice(2));}
  catch(error) {process.stderr.write(String(error.message).slice(0,500)+'\n');process.exitCode=1;}
}
