import test from 'node:test';import assert from 'node:assert/strict';import {redactSecrets}from '../src/scrub.js';
const secret='invented blue elephant';
test('review credential forms remove complete PSKs and curl userinfo',()=>{
 for(const text of [`curl -u 'fixture:invented-pass' https://fixture.invalid`,`curl --user fixture:invented-pass https://fixture.invalid`,`wpa_passphrase fixturenet '${secret}'`,`wpa-psk '${secret}'`,`nmcli con modify fixture wifi-sec.psk '${secret}'`,`nmcli con modify fixture 802-11-wireless-security.psk '${secret}'`,`vpn -psk '${secret}'`,`pre-shared-key '${secret}'`,`: PSK "${secret}"`,`<psk>${secret}</psk>`,`PSK_KEY='${secret}'`,`psk1='${secret}'`,`wifi_key='${secret}'`,`Der PSK lautet ${secret}`,`PSK lautet: ${secret}`,`the PSK is ${secret}`,`psk=${secret}`]){
  const out=redactSecrets(text).text;assert.ok(!out.includes('elephant')&&!out.includes('invented-pass'),text);assert.match(out,/\[REDACTED\]/);assert.equal(redactSecrets(out).text,out);
 }
});
test('PSK mode flags, questions, prose and references survive',()=>{
 for(const text of ['psk: true','use_psk=1','Ist PSK = WPA2 Personal oder brauche ich Enterprise?','Zum PSK: bitte nie im Klartext speichern','PSK=$VPN_PSK','PSK=/etc/fixture/key','PSK: siehe Passwortmanager'])assert.equal(redactSecrets(text).text,text,text);
});
