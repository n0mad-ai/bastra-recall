import test from 'node:test';import assert from 'node:assert/strict';import {redactSecrets}from '../src/scrub.js';
const secret='invented blue elephant';
// Prose bindings only redact a secret-shaped token; word-only prose stays readable.
const shaped='elephant2019';
test('review credential forms remove complete PSKs and curl userinfo',()=>{
 for(const text of [`curl -u 'fixture:invented-pass' https://fixture.invalid`,`curl --user fixture:invented-pass https://fixture.invalid`,`wpa_passphrase fixturenet '${secret}'`,`wpa-psk '${secret}'`,`nmcli con modify fixture wifi-sec.psk '${secret}'`,`nmcli con modify fixture 802-11-wireless-security.psk '${secret}'`,`vpn -psk '${secret}'`,`pre-shared-key '${secret}'`,`: PSK "${secret}"`,`<psk>${secret}</psk>`,`PSK_KEY='${secret}'`,`psk1='${secret}'`,`wifi_key='${secret}'`,`Der PSK lautet ${shaped}`,`PSK lautet: ${shaped}`,`the PSK is ${shaped}`,`psk=${secret}`]){
  const out=redactSecrets(text).text;assert.ok(!out.includes('elephant')&&!out.includes('invented-pass'),text);assert.match(out,/\[REDACTED\]/);assert.equal(redactSecrets(out).text,out);
 }
});
test('PSK mode flags, questions, prose and references survive',()=>{
 for(const text of ['psk: true','use_psk=1','Ist PSK = WPA2 Personal oder brauche ich Enterprise?','Zum PSK: bitte nie im Klartext speichern','PSK=$VPN_PSK','PSK=/etc/fixture/key','PSK: siehe Passwortmanager'])assert.equal(redactSecrets(text).text,text,text);
});
test('PSK continuations remain covered while mode prose is not a binding',()=>{
 assert.equal(redactSecrets('Das WLAN nutzt wpa-psk statt enterprise und das bleibt so.').text,'Das WLAN nutzt wpa-psk statt enterprise und das bleibt so.');
 const value='psk=fixture\\\nphrase2019x';assert.ok(!redactSecrets(value).text.includes('phrase2019x'));
});
test('credential scanning stays bounded on adversarial whitespace and XML runs',async()=>{
 const {execFile}=await import('node:child_process');const{promisify}=await import('node:util');
 const source=new URL('../src/scrub.ts',import.meta.url).href;
 const code=`const {redactSecrets}=await import(${JSON.stringify(source)});for(const text of ['psk=fixture'+ '\\t'.repeat(100000)+'end','<psk>'.repeat(15000)+'x','PSK'+ '\\t'.repeat(100000)+'unknown'])redactSecrets(text);`;
 await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',code],{timeout:10000});
});
