/** Settings fields come from the server registry. User text is never HTML. */
export function createSettingsPanel() {
  const dialog=document.getElementById("recall-settings"), fields=document.getElementById("settings-fields"), status=document.getElementById("settings-status"), save=document.getElementById("settings-save"), restart=document.getElementById("settings-restart"), nav=document.getElementById("settings-nav");
  if(!dialog||!fields)return;
  let csrf=null, model=null, active="general", changes=new Map();
  const areas={general:"Allgemein und Sprache",search:"Suche und Embeddings",hooks:"Hooks und Reflex",code:"Code-Index",archive:"Archiv",tasks:"Aufgaben",access:"Zugang",updates:"Updates",jarvis:"Assistent und Jarvis"};
  const message=text=>{status.textContent=text;};
  async function call(path,body) {
    const response=await fetch(path,{credentials:"same-origin",headers:{"Content-Type":"application/json",...(csrf?{"X-Bastra-Settings-CSRF":csrf}:{})},...(body===undefined?{}:{method:"POST",body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok){if(response.status===401)csrf=null;throw new Error(data.error||"Einstellungen nicht erreichbar");}return data;
  }
  const format=value=>value===null||value===undefined?"Nicht gesetzt":typeof value==="object"?JSON.stringify(value):String(value);
  function mark(key,value){changes.set(key,value);save.disabled=false;message("Ungespeicherte Änderungen");}
  function render() {
    fields.replaceChildren();nav.replaceChildren();
    for(const[area,label]of Object.entries(areas)) {
      const button=document.createElement("button");button.type="button";button.textContent=label;button.setAttribute("aria-pressed",String(area===active));button.addEventListener("click",()=>{active=area;render();});nav.append(button);
    }
    for(const entry of model.entries.filter(e=>(e.managed?"jarvis":e.area)===active)) {
      const row=document.createElement("div");row.className="settings-row";
      const label=document.createElement("label"),title=document.createElement("span");title.className="settings-label";title.textContent=entry.label;label.append(title);row.append(label);
      if(entry.managed) {
        const button=document.createElement("button");button.type="button";button.className="skill-declare";button.textContent="Name und lokale Adresse ändern";button.addEventListener("click",()=>{dialog.close();document.getElementById("assistant-settings-open")?.click();});row.append(button);
      } else {
        const selected=changes.has(entry.key)?changes.get(entry.key):entry.value;
        const value=selected===null?entry.default:selected;
        let input;
        if(entry.kind==="boolean") {input=document.createElement("input");input.type="checkbox";input.checked=!!value;}
        else if(entry.choices) {input=document.createElement("select");if(value===null){const option=document.createElement("option");option.value="";option.textContent="Nicht gesetzt";input.append(option);}for(const choice of entry.choices){const option=document.createElement("option");option.value=choice;option.textContent=choice;input.append(option);}input.value=value??"";}
        else if(entry.kind==="json") {input=document.createElement("textarea");input.rows=3;input.value=entry.secret?"":JSON.stringify(value??[],null,2);}
        else {input=document.createElement("input");input.type=entry.secret?"password":entry.kind==="number"?"number":"text";input.value=entry.secret?"":value??"";}
        input.id=`setting-${entry.key.replaceAll(".","-")}`;input.name=entry.key;input.disabled=entry.readonly;input.autocomplete="off";if(entry.secret)input.placeholder=entry.isSet?"Gesetzt — neuen Wert zum Ändern eingeben":"Nicht gesetzt";
        label.htmlFor=input.id;label.append(input);
        input.addEventListener("change",()=>{try{const value=entry.kind==="boolean"?input.checked:entry.kind==="number"?Number(input.value):entry.kind==="json"?JSON.parse(input.value):input.value;mark(entry.key,value);input.setCustomValidity("");}catch{input.setCustomValidity("Gültiges JSON eingeben");input.reportValidity();}});
        if(!entry.readonly){const reset=document.createElement("button");reset.type="button";reset.className="settings-reset";reset.textContent="Standard";reset.addEventListener("click",()=>{mark(entry.key,null);render();});row.append(reset);}
      }
      const note=document.createElement("p");note.className="settings-note";note.textContent=`${entry.restartRequired?"Wirksam nach Neustart: ":"Wirksam: "}${format(entry.effective)}${entry.envOverride.length?` · Umgebung hat Vorrang: ${entry.envOverride.map(e=>`${e.name}=${e.value}`).join(", ")}`:""}${entry.readonly?" · Automatisch verwaltet":""}`;row.append(note);fields.append(row);
    }
    if(active==="access")for(const client of model.oauthClients){const row=document.createElement("div");row.className="settings-row";const label=document.createElement("span");label.textContent=`${client.name} · ${client.grants} Freigabe(n)`;const button=document.createElement("button");button.className="skill-declare";button.textContent="Zugang widerrufen";button.addEventListener("click",async()=>{button.disabled=true;try{model=await call("/ui/settings/oauth/revoke",{clientId:client.id});render();message("Zugang widerrufen");}catch(error){message(error.message);button.disabled=false;}});row.append(label,button);fields.append(row);}
    if(active==="jarvis"){const note=document.createElement("p");note.className="settings-note";note.textContent="Weitere Jarvis-Funktionen folgen in einem eigenen Schritt.";fields.append(note);}
    restart.disabled=!model.restartAvailable;restart.title=model.restartAvailable?"Daemon kontrolliert neu starten":"Diesen Daemon und seine Clients über die bestehende Einrichtung neu starten.";
  }
  document.getElementById("settings-open")?.addEventListener("click",async()=>{dialog.showModal();message("Einstellungen werden geladen …");save.disabled=true;try{const session=await call("/ui/settings/session",{});csrf=session.csrf;model=await call("/ui/settings");changes=new Map();render();message("");}catch(error){message(error.message);}});
  document.getElementById("settings-close")?.addEventListener("click",()=>dialog.close());
  save.addEventListener("click",async()=>{save.disabled=true;try{const needsRestart=model.entries.some(e=>e.restartRequired&&changes.has(e.key));model=await call("/ui/settings",{changes:Object.fromEntries(changes)});changes.clear();render();message(needsRestart?"Gespeichert. Daemon und verbundene Clients für die markierten Optionen neu starten.":"Gespeichert");}catch(error){message(error.message);save.disabled=false;}});
  restart.addEventListener("click",async()=>{if(changes.size){message("Änderungen zuerst speichern.");return;}restart.disabled=true;try{await call("/ui/settings/restart",{});csrf=null;message("Neustart angefordert. Die Oberfläche kann nach dem Start neu geladen werden.");}catch(error){message(error.message);restart.disabled=false;}});
}
