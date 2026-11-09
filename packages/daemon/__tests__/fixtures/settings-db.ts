/** Raw backend fixtures, preserving tests for malformed stored settings. */
import { readAppRecord, writeAppRecord } from "../../src/app-record-store.js";
export async function readSettingsFixture(path:string,_encoding?:unknown):Promise<string> { return readAppRecord("settings",path); }
export async function writeSettingsFixture(path:string,text:string,_options?:unknown):Promise<void> { writeAppRecord("settings",path,text); }
