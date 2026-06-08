const fs = require("node:fs");
const path = require("node:path");

fs.mkdirSync(path.join(__dirname, "..", "dist"), { recursive: true });
