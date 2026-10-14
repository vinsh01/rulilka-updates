"use strict";
const FAMILY = "RULILKA-MYWHOOSH-ESP32-OTA1";
const SERVICE = "c8a161f0-0000-4e6a-9c1a-2f6a1b6d1000";
const uuid = n => `c8a161f0-000${n}-4e6a-9c1a-2f6a1b6d1000`;
const $ = id => document.getElementById(id);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let device, control, data, state, info, release, metadata;
let busy = false, cancelled = false, awaitingRestart = false, completed = false;
let acknowledged = 0, statusCode = 0, boardError = 0;
const errors = {
  1:'Передан неполный файл. Начните обновление заново.',
  2:'Файл повреждён. Начните обновление заново.',
  3:'Не удалось записать файл в Рулилку. Начните обновление заново.',
  4:'Рулилка не может принять этот размер файла. Проверьте, что это версия для MyWhoosh.',
  5:'Передача не начата. Подключитесь и повторите обновление.',
  6:'Этот файл предназначен для другой Рулилки. Обновление остановлено.',
  7:'Рулилка не смогла проверить прошивку. Начните обновление заново.',
  8:'Не удалось сохранить состояние обновления. Повторите попытку.',
  9:'Не удалось выбрать новую прошивку для запуска. Повторите попытку.',
  10:'Рулилка ещё проверяет запуск. Подождите 30 секунд.',
  11:'Передача прервалась. Начните обновление заново.'
};
function message(text,error=false){$('status').textContent=text;$('status').className='status'+(error?' error':'')}
function notify(event){
  const value=event.target.value;
  statusCode=value.getUint8(0);
  if(statusCode===1&&value.byteLength===5)acknowledged=value.getUint32(1,true);
  if(statusCode===3)boardError=value.byteLength>1?value.getUint8(1):5;
}
async function readInfo(){
  const value=await info.readValue();
  const result=JSON.parse(new TextDecoder().decode(value));
  if(result.family!==FAMILY)throw new Error('Выбрана другая модель Рулилки. Нужна прошивка MyWhoosh с обновлением.');
  return result;
}
async function attach(){
  const server=await device.gatt.connect();
  const service=await server.getPrimaryService(SERVICE);
  control=await service.getCharacteristic(uuid(2));data=await service.getCharacteristic(uuid(3));
  state=await service.getCharacteristic(uuid(4));info=await service.getCharacteristic(uuid(5));
  await state.startNotifications();state.addEventListener('characteristicvaluechanged',notify);
  return readInfo();
}
async function loadRelease(){
  const response=await fetch('manifest.json',{cache:'no-store'});
  if(!response.ok)throw new Error('Не удалось проверить обновления. Проверьте интернет и повторите подключение.');
  const value=await response.json();
  if(value.family!==FAMILY||typeof value.version!=='string'||!Number.isInteger(value.bytes)||!value.sha256?.match(/^[a-f0-9]{64}$/)||!value.md5?.match(/^[a-f0-9]{32}$/))throw new Error('Список обновлений повреждён. Повторите попытку позже.');
  const url=new URL(value.url,location.href);
  if(url.origin!==location.origin||!url.pathname.startsWith(new URL('.',location.href).pathname))throw new Error('Неверный адрес прошивки. Повторите попытку позже.');
  return {...value,url:url.href};
}
function disconnected(){
  if(awaitingRestart||completed)return;
  $('update').disabled=true;
  if(busy)cancelled=true;
  else message('Рулилка отключилась. Если режим обновления завершился, включите его снова и выберите устройство.',true);
}
$('connect').addEventListener('click',async()=>{
  if(busy)return;completed=false;$('connect').disabled=true;$('update').disabled=true;
  try{
    if(device?.gatt.connected)device.gatt.disconnect();
    device=await navigator.bluetooth.requestDevice({filters:[{services:[SERVICE]}]});
    device.addEventListener('gattserverdisconnected',disconnected);
    metadata=await attach();
    $('deviceInfo').hidden=false;$('deviceName').textContent=device.name||metadata.id;$('currentVersion').textContent=metadata.version;
    message('Проверяем доступную прошивку…');release=await loadRelease();
    $('releaseVersion').textContent=release.version;
    $('update').hidden=false;$('update').disabled=false;
    $('update').textContent=metadata.version===release.version?'Переустановить прошивку':'Обновить до '+release.version;
    message(metadata.version===release.version?'Установлена текущая версия. При необходимости её можно переустановить.':'Рулилка подключена. Можно обновлять.');
  }catch(error){message(error.name==='NotFoundError'?'Устройство не выбрано. Включите режим обновления и выберите Рулилку.':error.message,true)}
  finally{$('connect').disabled=false}
});
async function waitFor(test,timeout=30000){
  const started=Date.now();
  while(!test()){
    if(cancelled)throw new Error('Передача отменена. Текущая прошивка остаётся выбранной.');
    if(boardError)throw new Error(errors[boardError]||'Обновление остановлено устройством. Повторите попытку.');
    if(Date.now()-started>timeout)throw new Error('Рулилка не подтвердила приём. Подключитесь и начните заново.');
    await pause(20);
  }
  if(boardError)throw new Error(errors[boardError]||'Ошибка обновления.');
}
async function verifyRestart(){
  message('Файл проверен. Рулилка перезапускается; проверяем запуск новой версии…');
  await pause(2200);
  const deadline=Date.now()+65000;
  while(Date.now()<deadline){
    try{
      if(!device.gatt.connected)metadata=await attach();else metadata=await readInfo();
      if(metadata.version!==release.version||metadata.partition===window.partitionBefore)throw new Error('Новая прошивка ещё не запущена.');
      $('currentVersion').textContent=metadata.version;
      if(metadata.verified){
        await control.writeValueWithResponse(new Uint8Array([4]));
        completed=true;message('Готово: запущена версия '+metadata.version+'. Рулилка возвращается к рулению. Настройки сохранены.');
        $('progressText').textContent='Обновление и проверка запуска завершены';
        return;
      }
      message('Запущена версия '+metadata.version+'. Завершаем проверку запуска…');
    }catch(error){/* Retry discovery/read-back during restart; no success from disconnect alone. */}
    await pause(1000);
  }
  throw new Error('Передача завершена, но запуск новой версии не подтверждён. Не повторяйте обновление вслепую: проверьте версию в настройках Рулилки.');
}
$('update').addEventListener('click',async()=>{
  if(busy||!device?.gatt.connected||!release)return;
  busy=true;cancelled=false;awaitingRestart=false;boardError=0;statusCode=0;acknowledged=0;
  window.partitionBefore=metadata.partition;
  $('connect').disabled=$('update').disabled=true;$('stop').hidden=false;$('stop').disabled=false;$('progressPanel').hidden=false;
  try{
    message('Загружаем и проверяем файл прошивки…');
    const response=await fetch(release.url,{cache:'no-store'});if(!response.ok)throw new Error('Не удалось загрузить прошивку. Проверьте интернет и повторите попытку.');
    const buffer=await response.arrayBuffer(),bytes=new Uint8Array(buffer);
    const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),n=>n.toString(16).padStart(2,'0')).join('');
    if(bytes.length!==release.bytes||sha!==release.sha256||md5ArrayBuffer(buffer)!==release.md5||bytes[0]!==0xe9)throw new Error('Файл прошивки повреждён. Повторите попытку позже.');
    if(cancelled)throw new Error('Передача отменена. Текущая прошивка остаётся выбранной.');
    const start=new Uint8Array(37);start[0]=1;new DataView(start.buffer).setUint32(1,bytes.length,true);start.set(new TextEncoder().encode(release.md5),5);
    await control.writeValueWithResponse(start);await waitFor(()=>statusCode===1);
    message('Передаём прошивку. Оставьте питание включённым.');
    const withoutResponse=data.properties.writeWithoutResponse&&typeof data.writeValueWithoutResponse==='function';
    for(let offset=0;offset<bytes.length;){
      await waitFor(()=>offset-acknowledged<4096);
      const end=Math.min(offset+200,bytes.length),chunk=bytes.subarray(offset,end);
      if(withoutResponse)await data.writeValueWithoutResponse(chunk);else await data.writeValueWithResponse(chunk);
      offset=end;const percent=Math.floor(acknowledged/bytes.length*100);$('progress').value=percent;$('progressText').textContent='Рулилка подтвердила '+percent+'% файла';
    }
    await waitFor(()=>acknowledged===bytes.length);$('progress').value=100;
    $('stop').disabled=true;awaitingRestart=true;
    await control.writeValueWithResponse(new Uint8Array([2]));
    await waitFor(()=>statusCode===2,15000);await verifyRestart();
  }catch(error){
    if(!awaitingRestart&&device?.gatt.connected)try{await control.writeValueWithResponse(new Uint8Array([3]))}catch(ignore){}
    message(error.message,true);
  }finally{
    busy=false;$('stop').hidden=true;$('connect').disabled=false;
    // A verified update returns to the saved steering mode; require explicit reconnection.
    $('update').disabled=true;awaitingRestart=false;
  }
});
$('stop').addEventListener('click',()=>{cancelled=true;$('stop').disabled=true;message('Отменяем передачу…')});
if(!navigator.bluetooth||!window.isSecureContext){
  $('connect').disabled=true;message('Этот браузер не поддерживает обновление по Bluetooth. Откройте страницу в Chrome на компьютере или Android по защищённому адресу сайта.',true);
}
