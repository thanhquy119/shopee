import { generateKeyPairSync, randomBytes } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwkPublic = publicKey.export({ format: "jwk" });
const jwkPrivate = privateKey.export({ format: "jwk" });

const toBuffer = (value) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const x = toBuffer(jwkPublic.x);
const y = toBuffer(jwkPublic.y);
const d = toBuffer(jwkPrivate.d);
const vapidPublic = Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64url");
const vapidPrivate = d.toString("base64url");
const appToken = randomBytes(32).toString("base64url");

console.log(`APP_TOKEN=${appToken}`);
console.log(`VAPID_PUBLIC_KEY=${vapidPublic}`);
console.log(`VAPID_PRIVATE_KEY=${vapidPrivate}`);
console.log("VAPID_SUBJECT=mailto:your-email@example.com");
