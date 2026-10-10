/** Frozen #1113 extension: one positive and one negative per requested form.
 * Before-filter outcomes are from main 75a469de; no new counterexample search. */
const value = ["invented", "meadow"].join("");
interface NetworkRow {
  source: string; label: string; input: string; absent?: string[]; present?: string[];
  unchanged?: boolean; baselinePass: boolean; knownLimit: boolean;
}
const positive = (label: string, input: string, present: string[] = []): NetworkRow =>
  ({ source: "network-1113-fixed", label, input, absent: [value], present, baselinePass: false, knownLimit: false });
const negative = (label: string, input: string): NetworkRow =>
  ({ source: "network-1113-fixed", label, input, unchanged: true, baselinePass: true, knownLimit: false });
export const NETWORK_ROWS: NetworkRow[] = [
  positive("nmcli", `nmcli dev wifi connect InventedSSID password ${value}`, ["InventedSSID"]),
  negative("nmcli reference", 'nmcli dev wifi connect InventedSSID password "$WIFI_SECRET"'),
  positive("networksetup", `networksetup -setairportnetwork en0 "Invented SSID" "${value}"`, ["en0", "Invented SSID"]),
  negative("networksetup reference", 'networksetup -setairportnetwork en0 InventedSSID "$WIFI_SECRET"'),
  positive("netsh Key Content", `    Key Content            : ${value}`),
  negative("netsh prose", "The Key Content column describes the output layout."),
  positive("WiFi.begin", `WiFi.begin("InventedSSID", "${value}");`, ["InventedSSID"]),
  negative("WiFi.begin symbol", 'WiFi.begin("InventedSSID", WIFI_SECRET);'),
  positive("define WIFI_PSK", `#define WIFI_PSK "${value}"`),
  negative("define WIFI_PSK symbol", "#define WIFI_PSK WIFI_SECRET"),
  positive("Fortinet", `  set psksecret "${value}"`),
  negative("Fortinet prose", "Fortinet documents set psksecret as a configuration command."),
  positive("VyOS", `set vpn ipsec site-to-site peer 192.0.2.15 authentication pre-shared-secret '${value}'`, ["192.0.2.15"]),
  negative("VyOS prose", "VyOS pre-shared-secret is an authentication setting."),
  positive("uci", `uci set wireless.fixture.key='${value}'`, ["wireless.fixture.key"]),
  negative("uci read", "uci show wireless.fixture.key"),
  positive("pre-shared-key XML", `<pre-shared-key>${value}</pre-shared-key>`),
  negative("pre-shared-key XML reference", "<pre-shared-key>${WIFI_SECRET}</pre-shared-key>"),
  positive("psk_old", `psk_old=${value}`),
  negative("psk_old reference", "psk_old=$WIFI_SECRET"),
  positive("PSK_GUEST", `PSK_GUEST=${value}`),
  negative("PSK_GUEST reference", "PSK_GUEST=${WIFI_SECRET}"),
  positive("psks array", JSON.stringify({ psks: [value, value] })),
  negative("psks array reference", '{"psks":["$WIFI_SECRET"]}'),
  positive("Cisco", `crypto isakmp key ${value} address 192.0.2.15`, ["192.0.2.15"]),
  negative("Cisco reference", "crypto isakmp key $WIFI_SECRET address 192.0.2.15"),
  positive("OpenWrt", `option key '${value}'`),
  negative("OpenWrt reference", "option key '$WIFI_SECRET'"),
  positive("Wi-Fi QR", `WIFI:T:WPA;S:InventedSSID;P:${value};;`, ["InventedSSID", "WIFI:T:WPA;"]),
  negative("Wi-Fi QR reference", "WIFI:T:WPA;S:InventedSSID;P:$WIFI_SECRET;;"),
  positive("curl attached bundle", `curl -sufixture:${value} https://fixture.invalid`, ["https://fixture.invalid"]),
  negative("curl bundle reference", "curl -su'fixture:$WIFI_SECRET' https://fixture.invalid"),
  positive("http auth", `http -a fixture:${value} https://fixture.invalid`, ["https://fixture.invalid"]),
  negative("http auth reference", "http -a 'fixture:$WIFI_SECRET' https://fixture.invalid"),
];
