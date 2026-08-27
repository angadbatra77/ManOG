import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./config.js";
import resultsRouter from "./routes/results.js";
import holdingsRouter from "./routes/holdings.js";
import sellSignalsRouter from "./routes/sellSignals.js";
import upstoxRouter from "./routes/upstox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", resultsRouter);
app.use("/api", holdingsRouter);
app.use("/api", sellSignalsRouter);
app.use("/api", upstoxRouter);

// In production the client is built to ../../client/dist and served from
// this same service, so the whole app runs as one Render web service.
const clientDist = path.join(__dirname, "../../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`ManOG screener server listening on http://localhost:${PORT}`);
});
