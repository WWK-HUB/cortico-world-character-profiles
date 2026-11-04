import {readFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createProfileService} from './profile-api.js';

/** Complete a recorded one-shot position restore using only supported native APIs.
 * Retain the marker on failure so a subsequent single boot can finish it. */
export function startPositionResume(home:string,report:(message:string)=>void):()=>void {
 let stopped=false,busy=false,done=false;
 const timer=setInterval(()=>{if(!busy&&!done&&!stopped)void attempt();},1000);
 timer.unref();
 async function attempt(){busy=true;try{
   const api=createProfileService(home);if(api.currentMode())return;
   const index=JSON.parse(readFileSync(join(home,'roles','index.json'),'utf8'));
   const roleId=index.active;if(typeof roleId!=='string')return;
   const file=join(home,'character-profiles','runtime-ownership',roleId+'.position-transfer.json');
   if(!existsSync(file)){done=true;return;}const marker=JSON.parse(readFileSync(file,'utf8'));
   if(marker.roleId!==roleId||marker.phase!=='resume'||typeof marker.desired!=='boolean')throw Error('位置恢复标记无效');
   // The active role must still resolve to its validated physical storage.
   api.getStorageDescriptor(roleId);
   const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-NetTCPConnection -State Listen -OwningProcess ${process.pid} -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' } | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress`],{windowsHide:true,encoding:'utf8',timeout:6000});
   if(result.status!==0||!result.stdout.trim())return;
   const value=JSON.parse(result.stdout);for(const port of (Array.isArray(value)?value:[value]).slice(0,16)){
     if(!Number.isInteger(port)||port<1||port>65535)continue;
     const origin=`http://127.0.0.1:${port}`;
     try{
       const response=await fetch(origin+'/api/webui/providers/world%3Adesktop-pet/panels/pet/state',{method:'POST',headers:{'content-type':'application/json'},body:'{"args":[]}',signal:AbortSignal.timeout(1500)});
       if(!response.ok)continue;const state=await response.json() as {onDesktop?:boolean};if(state.onDesktop!==true)continue;
       if(stopped||api.currentMode())return;
       const fresh=JSON.parse(readFileSync(file,'utf8'));if(JSON.stringify(fresh)!==JSON.stringify(marker))return;
       const saved=await fetch(origin+'/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({group:'world:desktop-pet',values:{'worlds.desktop-pet.rememberPosition':marker.desired}}),signal:AbortSignal.timeout(3000)});
       if(!saved.ok)throw Error('原生设置恢复失败');
       unlinkSync(file);done=true;report('已恢复原单宠的位置记忆开关，当前位置不变');return;
     }catch(error){report('位置设置恢复等待重试：'+(error as Error).message);}
   }
 }catch(error){report('位置恢复未完成：'+(error as Error).message);}finally{busy=false;}}
 return ()=>{stopped=true;clearInterval(timer);};
}
