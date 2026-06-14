import "dotenv/config";
import { discoverGoogleAccess } from "./googleDiscovery.js";

const access = await discoverGoogleAccess(process.argv[2]);
console.log(JSON.stringify(access, null, 2));
