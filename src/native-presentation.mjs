// Shared presentation whitelist and revision validation. No file IO.
const number=(v,min,max,name)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error('Invalid display '+name);return v;};
const text=v=>{if(typeof v!=='string'||v.length>256)throw Error('Invalid display string');return v;};
const skinKeys=['figure','scheme','palette','head','side','glasses','neck'];
const ranges={scale:[.5,10],bubbleSize:[.8,1.6],fontSize:[.8,1.6],bubbleSpeed:[.5,2]};
export function displayFields(cfg){
 const result={};
 if(cfg.skin){result.skin={};for(const key of skinKeys)if(Object.hasOwn(cfg.skin,key))result.skin[key]=text(cfg.skin[key]);
   if(cfg.skin.colors){result.skin.colors={};for(const [key,c]of Object.entries(cfg.skin.colors)){if(['__proto__','constructor','prototype'].includes(key))throw Error('Invalid color slot');result.skin.colors[text(key)]={main:text(c.main),acc:text(c.acc)};}}
 }
 if(cfg.window){result.window={};for(const [key,[min,max]]of Object.entries(ranges))if(Object.hasOwn(cfg.window,key))result.window[key]=number(cfg.window[key],min,max,key);}
 for(const key of ['petX','petY'])if(Object.hasOwn(cfg,key))result[key]=cfg[key]===null?null:number(cfg[key],0,1,key);
 if(Object.hasOwn(cfg,'rememberPosition')){if(typeof cfg.rememberPosition!=='boolean')throw Error('Invalid position flag');result.rememberPosition=cfg.rememberPosition;}
 if(Object.hasOwn(cfg,'theme')){if(!['dark','light'].includes(cfg.theme))throw Error('Invalid display theme');result.theme=cfg.theme;}
 return result;
}
export function captureDisplay({roleId,source,config,previous=null}){
 if(typeof roleId!=='string'||!roleId.trim())throw Error('Missing stable roleId');
 if(!['live-native','persisted-native','managed'].includes(source))throw Error('Unknown display source');
 if(previous&&(previous.schema!==1||previous.roleId!==roleId||!Number.isSafeInteger(previous.revision)||previous.revision<1||previous.revision>=Number.MAX_SAFE_INTEGER))throw Error('Display identity/revision mismatch');
 return {schema:1,roleId,revision:(previous?.revision??0)+1,source,coordinateSystem:'native-window-fractions-primary-display-on-start',display:displayFields(config)};
}
export function acceptDisplay(current,incoming){
 if(!current||incoming.schema!==1||incoming.roleId!==current.roleId||!Number.isSafeInteger(incoming.revision)||incoming.revision!==current.revision+1)throw Error('Display revision conflict');
 return {...incoming,display:displayFields(incoming.display)};
}

export function presentationFields(cfg){const out=displayFields(cfg);for(const [key,values] of [['roam',['off','calm','free']],['selfAdjust',['off','default','any','custom']]])if(Object.hasOwn(cfg,key)){const v=cfg[key];if(!values.includes(v)&&!(key==='selfAdjust'&&typeof v==='boolean'))throw Error('身体设置无效');out[key]=v;}if(cfg.selfAdjustCustom){out.selfAdjustCustom={};for(const [key,v] of Object.entries(cfg.selfAdjustCustom)){if(!['figure','scheme','roam','snoreSeconds','sound','scale','bubbleSize','fontSize','theme','hoverButtons','user'].includes(key)||typeof v!=='boolean')throw Error('自调整权限无效');out.selfAdjustCustom[key]=v;}}if(cfg.touch){out.touch={};for(const [key,v] of Object.entries(cfg.touch)){if(key==='enabled'){if(typeof v!=='boolean')throw Error('触摸开关无效');out.touch.enabled=v;}else if(key==='wakeOn'){if(!['all','poke','custom','none'].includes(v))throw Error('触摸唤醒无效');out.touch.wakeOn=v;}else if(key==='wakeKinds'){if(!Array.isArray(v)||v.some(x=>!['poke','pet','throw','drop','crash'].includes(x)))throw Error('触摸类型无效');out.touch.wakeKinds=[...v];}}}if(Object.hasOwn(cfg,'sound')){if(typeof cfg.sound!=='boolean')throw Error('声音开关无效');out.sound=cfg.sound;}if(cfg.sounds){out.sounds={};for(const key of ['move','touch','face','snore','talk','ui','panByPosition'])if(Object.hasOwn(cfg.sounds,key)){if(typeof cfg.sounds[key]!=='boolean')throw Error('声音选项无效');out.sounds[key]=cfg.sounds[key];}if(Object.hasOwn(cfg.sounds,'snoreSeconds'))out.sounds.snoreSeconds=number(cfg.sounds.snoreSeconds,0,3600,'snoreSeconds');if(Object.hasOwn(cfg.sounds,'volume')){const v=cfg.sounds.volume;if(typeof v!=='number'||!Number.isFinite(v))throw Error('音量需为 0–100 的数字');if(!Number.isInteger(v)||v<0||v>100)throw Error('音量需为 0–100 的整数');out.sounds.volume=v;}}if(cfg.speech){out.speech={};if(Object.hasOwn(cfg.speech,'enabled')){if(typeof cfg.speech.enabled!=='boolean')throw Error('朗读开关无效');out.speech.enabled=cfg.speech.enabled;}for(const key of ['pitch','speed'])if(Object.hasOwn(cfg.speech,key)){if(!['low','mid','high','custom'].includes(cfg.speech[key]))throw Error('朗读档位无效');out.speech[key]=cfg.speech[key];}for(const [key,min,max] of [['pitchHz',200,700],['unitsPerSecond',6,20]])if(Object.hasOwn(cfg.speech,key))out.speech[key]=number(cfg.speech[key],min,max,key);}return out;}
export function speechSettings(cfg){const s=cfg.speech??{};return {enabled:cfg.sound===true&&s.enabled===true,pitchHz:s.pitch==='custom'?number(s.pitchHz,200,700,'pitchHz'):({low:300,mid:400,high:500}[s.pitch]??400),unitsPerSecond:s.speed==='custom'?number(s.unitsPerSecond,6,20,'unitsPerSecond'):({low:10,mid:13,high:16}[s.speed]??13)};}
