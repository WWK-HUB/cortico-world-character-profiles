import {presentationFields} from './native-presentation.mjs';
/** Side-effect-free profile service. Importing this module never bootstraps a deployment. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, existsSync, realpathSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep, dirname, basename } from 'node:path';
import { listRoles, readIndex, rolePaths, roleEffectiveDataDir, writeRoleConfig } from './roles.js';
import { roleWorkspace } from './panel.js';
import { acquireInstanceLock } from 'cortico/core/instance-lock.ts';

export const PROFILE_PROTOCOL = 1;
export interface Owner { pid: number; nonce: string; }
export interface Lease { roleId: string; generation: string; owner: Owner; modeGeneration: string; physicalDir: string; dataDir: string; memoryDir: string; }
const read = <T>(file: string): T | null => { try { return JSON.parse(readFileSync(file,'utf8')); } catch { if(existsSync(file)) throw Error('存储损坏，需要恢复：'+file); return null; } };
const equal = (a: Owner,b: Owner) => a.pid===b.pid && a.nonce===b.nonce;
const alive = (pid: number) => {try {process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}};
function exclusive(file: string,value: unknown) {const fd=openSync(file,'wx');try{writeFileSync(fd,JSON.stringify(value));}finally{closeSync(fd);}}
function atomic(file: string,value: unknown){const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value));renameSync(tmp,file);}
const key=(p:string)=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const within=(root:string,p:string)=>key(root)===key(p)||key(p).startsWith(key(root)+sep);
const overlaps=(a:string,b:string)=>within(a,b)||within(b,a);
function physicalDirectory(file:string):string{
  if(!file||file.includes('\0'))throw Error('存储路径无效');
  const absolute=resolve(file);
  if(existsSync(absolute)){if(!statSync(absolute).isDirectory())throw Error('存储路径不是目录');return realpathSync.native(absolute);}
  const parent=dirname(absolute);if(parent===absolute)throw Error('存储路径无法解析');
  return join(physicalDirectory(parent),basename(absolute));
}
export function createProfileService(home: string) {
  home=realpathSync.native(home);
  const control=join(home,'character-profiles','runtime-ownership');
  const modeFile=join(control,'mode.json');
  const capabilities=()=>({version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version,protocol:PROFILE_PROTOCOL,enabled:read<any>(join(home,'companion','config.json'))?.worlds?.['character-profiles']?.enabled===true,capabilities:['profiles','fixed-paths','exclusive-mode','role-leases','single-boot-gate','crash-safe-recovery','supervised-stop','effective-storage','role-presentation','role-body','channel-persona-sources']});
  function validateOwner(owner: Owner){if(owner.pid!==process.pid || !/^[0-9a-f-]{36}$/.test(owner.nonce))throw Error('所有者身份无效');}
  function rawStorage(roleId:string){
    const role=listRoles(home).find(r=>r.id===roleId);if(!role)throw Error('未知角色');
    const physicalDir=realpathSync.native(rolePaths(home).roleDir(roleId));
    const rolesRoot=realpathSync.native(join(home,'roles'))+sep;
    if(!physicalDir.startsWith(rolesRoot))throw Error('角色路径越界');
    const config=read<any>(join(physicalDir,'config.json'))??{};
    for(const name of ['memory','data']){const value=config.paths?.[name];if(value!==undefined&&(typeof value!=='string'||!value.trim()||value.includes('\0')))throw Error('角色存储配置无效');}
    const memoryDir=physicalDirectory(roleWorkspace(home,roleId)),dataDir=physicalDirectory(roleEffectiveDataDir(home,roleId));
    for(const dir of [memoryDir,dataDir])if(!existsSync(dir)&&!within(physicalDir,dir))throw Error('外置存储目录不存在，请核对配置');
    return {roleId,label:role.label,figures:[...role.figures],physicalDir,memoryDir,dataDir,config};
  }
  function storage(roleId:string){
    const s=rawStorage(roleId);
    if(overlaps(s.memoryDir,s.dataDir))throw Error('角色 memory/data 目录重叠');
    for(const dir of [s.memoryDir,s.dataDir]){
      // Canonical paths, including junction targets, may be external but never another role's storage.
      for(const r of listRoles(home))if(r.id!==roleId){const other=rawStorage(r.id);if([other.physicalDir,other.memoryDir,other.dataDir].some(p=>overlaps(dir,p)))throw Error('角色存储与其他角色重叠或路径越界');}
      for(const reserved of ['character-profiles','multi-companion','extensions','providers'])if(overlaps(dir,join(home,reserved)))throw Error('角色存储与部署控制目录重叠');
    }
    return s;
  }
  function documentMetadata(roleId:string){
    const {config,...s}=storage(roleId),validName=(n:unknown):n is string=>typeof n==='string'&&/^[A-Za-z0-9_-]+\.md$/.test(n);
    const shared:string[]=Array.isArray(config.multiCompanion?.publicPersonaFiles)?config.multiCompanion.publicPersonaFiles:[];
    if(shared.some(n=>!validName(n)))throw Error('共享人设文件名无效');
    const names=[...new Set([...readdirSync(s.memoryDir,{withFileTypes:true}).filter(e=>(e.isFile()||e.isSymbolicLink())&&validName(e.name)).map(e=>e.name),...shared])].sort();
    const documents=names.map(name=>{
      let missing=false,unavailable='',fingerprint='';
      try{const file=realpathSync.native(join(s.memoryDir,name));
        if(!within(s.memoryDir,file)||!statSync(file).isFile())unavailable='文档路径越界或不是文件';
        else if(shared.includes(name))fingerprint=createHash('sha256').update(readFileSync(file)).digest('hex');
      }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')missing=true;else throw e;}
      return {name,shared:shared.includes(name),missing,unavailable,fingerprint};
    });
    const revision=createHash('sha256').update(JSON.stringify({config,storage:s,documents})).digest('hex');
    return {s,config,documents,revision};
  }
  function snapshot(roleId: string) {
    const {s,config,documents,revision}=documentMetadata(roleId);
    const publicPersona=documents.filter(d=>d.shared).map(d=>{
      if(d.missing||d.unavailable)throw Error('共享人设文档不可用：'+d.name+'；请在共享设置中解除或修复引用');
      const file=realpathSync.native(join(s.memoryDir,d.name));if(!within(s.memoryDir,file))throw Error('共享人设路径越界');return readFileSync(file,'utf8');
    }).join('\n\n');
    return {...s,timezone:config.timezone??'Asia/Shanghai',personaSources:documents.filter(d=>d.shared).map(d=>d.name),inputHotkeys:{typeKey:config.worlds?.['desktop-pet']?.typeKey??{},voice:config.worlds?.['desktop-pet']?.asr?.mic?.hotkey??null},skin:config.worlds?.['desktop-pet']?.skin??{},model:config.activeProvider??'',publicPersona,revision};
  }
  function requireMode(owner: Owner,generation: string){validateOwner(owner);const mode=read<any>(modeFile);if(!mode || !equal(mode.owner,owner)||mode.generation!==generation)throw Error('模式所有权已失效');return mode;}
  const positionFile=(id:string)=>join(control,id+'.position-transfer.json');
  function preparePositionResume(roleId:string){
    const marker=read<any>(positionFile(roleId));if(!marker)return;
    const s=storage(roleId),cfg=s.config,pet=cfg.worlds?.['desktop-pet'];
    if(!pet||marker.roleId!==roleId)throw Error('位置移交身份无效');
    // A one-shot native initial position. The front World restores the user's flag
    // through the official hot-config API only after the renderer is connected.
    if(marker.desired===false){atomic(positionFile(roleId),{...marker,phase:'resume'});pet.rememberPosition=true;writeRoleConfig(home,roleId,cfg);}
    else unlinkSync(positionFile(roleId));
  }
  function requireLease(lease:Lease){requireMode(lease.owner,lease.modeGeneration);const saved=read<Lease>(join(control,lease.roleId+'.lease.json'));if(!saved||saved.generation!==lease.generation||!equal(saved.owner,lease.owner))throw Error('角色租约已失效');for(const k of ['physicalDir','memoryDir','dataDir'] as const)if(key(saved[k])!==key(lease[k]))throw Error('租约存储身份无效');return saved;}
  return {
    capabilities,
    listProfiles:()=>{const index=readIndex(home);if(!index||!Array.isArray(index.roles))throw Error('角色注册表暂时不可读');return listRoles(home).map(r=>({roleId:r.id,label:r.label,figures:r.figures,avatarAvailable:existsSync(join(rolePaths(home).roleDir(r.id),'avatar.png'))}));},
    getProfileSnapshot:snapshot,
    getStorageDescriptor(roleId:string){const {config,...s}=storage(roleId);return s;},
    resolveSingleStorage(dataDir:string){const id=readIndex(home)?.active;if(!id)throw Error('没有活动角色');const {config,...s}=storage(id);if(key(physicalDirectory(dataDir))!==key(s.dataDir))throw Error('原 Core 的角色存储身份无效');return s;},
    listPersonaDocuments(roleId:string){const {revision,documents}=documentMetadata(roleId);return {revision,files:documents.map(({fingerprint,...d})=>d)};},
    setSharedPersona(roleId:string,names:string[],expectedRevision:string){const {config,documents,revision}=documentMetadata(roleId);if(revision!==expectedRevision)throw Error('档案已修改，请刷新');const allowed=documents.filter(d=>!d.missing&&!d.unavailable).map(d=>d.name);if(!Array.isArray(names)||names.some(n=>!allowed.includes(n)))throw Error('共享文件无效，请先解除失效引用');config.multiCompanion={...config.multiCompanion,publicPersonaFiles:[...new Set(names)]};writeRoleConfig(home,roleId,config);return documentMetadata(roleId).revision;},
    currentMode:()=>read<any>(modeFile),
    modeStopRequested(owner:Owner,generation:string){requireMode(owner,generation);const request=read<any>(join(control,'mode-stop.json'));return request?.generation===generation&&equal(request.owner,owner);},
    recoverAbandonedMode(){
      const mode=read<any>(modeFile);if(!mode)return {recovered:false};
      if(alive(mode.owner.pid))throw Error('协调器仍然存活，禁止恢复抢占');
      const recovery=join(control,'recovery');mkdirSync(recovery,{recursive:true});
      const mutex=acquireInstanceLock(recovery);
      try{
        const current=read<any>(modeFile);if(!current||current.generation!==mode.generation)throw Error('模式已改变，取消恢复');
        const leases: string[]=[];
        for(const role of listRoles(home)){
          const file=join(control,role.id+'.lease.json');const lease=read<Lease>(file);if(!lease)continue;
          if(!equal(lease.owner,mode.owner)||lease.modeGeneration!==mode.generation)throw Error('发现不属于旧模式的租约，需要人工恢复');
          const current=storage(role.id);
          if(key(physicalDirectory(lease.dataDir))!==key(lease.dataDir)||key(physicalDirectory(lease.memoryDir))!==key(lease.memoryDir)||key(current.physicalDir)!==key(lease.physicalDir))throw Error('原租约物理路径已改变，拒绝恢复');
          for(const data of new Set([lease.dataDir,current.dataDir])){const lock=read<any>(join(data,'instance.lock'));if(lock&&alive(lock.pid))throw Error('角色实例仍然存活，稍后重试恢复');}
          leases.push(file);
        }
        for(const file of leases)unlinkSync(file);if(current.previousRoleId)preparePositionResume(current.previousRoleId);unlinkSync(modeFile);return {recovered:true,generation:mode.generation,leases:leases.length};
      }finally{mutex.release();}
    },
    acquireMode(mode:'single'|'multi',owner:Owner){validateOwner(owner);mkdirSync(control,{recursive:true});const value={mode,owner,generation:randomUUID(),state:mode==='multi'?'entering_multi':'single',previousRoleId:readIndex(home)?.active,at:new Date().toISOString()};try{exclusive(modeFile,value);}catch{throw Error('模式已占用；不得仅凭超时抢占，请先确认旧协调器及角色退出');}return value;},
    commitMode(owner:Owner,generation:string,state:'multi'|'leaving_multi'){const mode=requireMode(owner,generation);atomic(modeFile,{...mode,state});},
    releaseMode(owner:Owner,generation:string){const mode=requireMode(owner,generation);for(const role of listRoles(home)){if(existsSync(join(control,role.id+'.lease.json')))throw Error('仍有角色租约，不能退出模式');}if(mode.previousRoleId)preparePositionResume(mode.previousRoleId);unlinkSync(modeFile);const stopFile=join(control,'mode-stop.json');if(read<any>(stopFile)?.generation===generation)unlinkSync(stopFile);},
    beginPositionTransfer(owner:Owner,generation:string,roleId:string){requireMode(owner,generation);if(read<any>(positionFile(roleId))?.phase==='resume')throw Error('原生位置设置正在恢复，请稍后重试');const current=this.getRolePresentation(roleId);if(current.settings.rememberPosition===false)atomic(positionFile(roleId),{roleId,desired:false,generation,phase:'capture'});return current;},
    cancelPositionTransfer(owner:Owner,generation:string,roleId:string){requireMode(owner,generation);const file=positionFile(roleId),m=read<any>(file);if(m?.generation===generation)unlinkSync(file);},
    acquireRoleLease(roleId:string,owner:Owner,modeGeneration:string):Lease{validateOwner(owner);requireMode(owner,modeGeneration);const s=storage(roleId);const lock=read<any>(join(s.dataDir,'instance.lock'));if(lock && alive(lock.pid))throw Error('角色仍被单角色 Core 占用');const value={roleId,generation:randomUUID(),owner,modeGeneration,physicalDir:s.physicalDir,dataDir:s.dataDir,memoryDir:s.memoryDir};exclusive(join(control,roleId+'.lease.json'),value);return value;},
    renewLease(lease:Lease){const saved=requireLease(lease);const s=storage(lease.roleId);for(const k of ['physicalDir','memoryDir','dataDir'] as const)if(key(saved[k])!==key(s[k]))throw Error('档案存储已改变，需停止旧实例并恢复后重试');return saved;},
    getRolePresentation(roleId:string){const s=storage(roleId),settings=presentationFields(s.config.worlds?.['desktop-pet']??{}),marker=read<any>(positionFile(roleId));if(marker?.roleId===roleId)settings.rememberPosition=marker.desired;return {roleId,settings,revision:createHash('sha256').update(JSON.stringify(settings)).digest('hex')};},
    setRolePresentation(lease:Lease,patch:Record<string,any>,expectedRevision?:string){this.renewLease(lease);if(!patch||Object.keys(patch).some(k=>!['skin','window','petX','petY','rememberPosition','theme','sound','sounds','speech','roam','selfAdjust','selfAdjustCustom','touch'].includes(k)))throw Error('展示/朗读字段无效');const current=this.getRolePresentation(lease.roleId);if(expectedRevision&&current.revision!==expectedRevision)throw Error('展示配置已改变，请刷新');const clean=presentationFields(patch),s=storage(lease.roleId),cfg=s.config,old=cfg.worlds?.['desktop-pet']??{};cfg.worlds={...cfg.worlds,'desktop-pet':{...old,...clean,...(clean.window?{window:{...old.window,...clean.window}}:{}),...(clean.speech?{speech:{...old.speech,...clean.speech}}:{}),...(clean.sounds?{sounds:{...old.sounds,...clean.sounds}}:{}),...(clean.touch?{touch:{...old.touch,...clean.touch}}:{}),...(clean.selfAdjustCustom?{selfAdjustCustom:{...old.selfAdjustCustom,...clean.selfAdjustCustom}}:{})}};writeRoleConfig(home,lease.roleId,cfg);const marker=read<any>(positionFile(lease.roleId));if(marker&&Object.hasOwn(clean,'rememberPosition'))atomic(positionFile(lease.roleId),{...marker,desired:clean.rememberPosition});return this.getRolePresentation(lease.roleId);},
    setRoleAppearance(lease:Lease,skin:Record<string,unknown>){this.renewLease(lease);if(!skin||typeof skin!=='object'||JSON.stringify(skin).length>8192||Object.keys(skin).some(k=>!['figure','scheme','palette','head','side','glasses','neck','colors'].includes(k)))throw Error('外观配置无效');const s=storage(lease.roleId),cfg=read<any>(join(s.physicalDir,'config.json'));cfg.worlds['desktop-pet']={...cfg.worlds['desktop-pet'],skin};writeRoleConfig(home,lease.roleId,cfg);},
    releaseLease(lease:Lease){const saved=requireLease(lease);if(key(physicalDirectory(saved.dataDir))!==key(saved.dataDir))throw Error('租约物理路径改变，拒绝推测释放');const lock=read<any>(join(saved.dataDir,'instance.lock'));if(lock && alive(lock.pid))throw Error('真实 Core 仍存活，不释放写入权');unlinkSync(join(control,lease.roleId+'.lease.json'));},
    prepareRoleRuntime(lease:Lease){this.renewLease(lease);return snapshot(lease.roleId);},
  };
}

/** Hold restarted single Core before loadDeployment opens the active profile. No timeout takeover. */
export async function waitForSingleMode(home: string): Promise<void> {
  const file=join(home,'character-profiles','runtime-ownership','mode.json');
  if(!existsSync(file))return;
  let closing=false;
  const onMessage=(message:any)=>{
    if(message?.type!=='companion:shutdown')return;
    closing=true;
    try{const mode=read<any>(file);if(mode?.mode==='multi')atomic(join(home,'character-profiles/runtime-ownership/mode-stop.json'),{generation:mode.generation,owner:mode.owner,requestedBy:process.pid,requestedAt:new Date().toISOString()});}catch{process.exit(1);}
  };
  process.on('message',onMessage);
  try{while(existsSync(file)) {
    const mode=read<any>(file);
    if(mode?.mode!=='multi')break;
    if(!alive(mode.owner.pid)){
      try{createProfileService(home).recoverAbandonedMode();continue;}catch(e){if(!(e as Error).message.includes('实例仍然存活'))throw e;}
    }
    // Dead owner is deliberately not treated as permission to write: workers may still be exiting.
    await new Promise(r=>setTimeout(r,250));
  }}finally{process.off('message',onMessage);}
  if(closing)process.exit(0);
}
