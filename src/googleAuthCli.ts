import "dotenv/config";
import { runGoogleOAuthLogin } from "./googleAuth.js";

await runGoogleOAuthLogin(process.argv[2]);
