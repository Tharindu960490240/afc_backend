const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const env = require("./config/env");
const limits = require("./middlewares/rateLimit");
const { notFound, errorHandler } = require("./middlewares/errorHandler");

const app = express();
app.disable("x-powered-by");
if (env.trustProxy) app.set("trust proxy", env.trustProxy);

app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // no Origin header = curl / server-to-server; browsers always send one
      if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use("/api", limits.global);
// Signatures drawn on screen travel as a small PNG, so agreements get a larger (still tight) limit.
app.use("/api/agreements", express.json({ limit: "300kb" }));
app.use(express.json({ limit: "100kb" }));
app.use("/api", require("./routes"));
app.get("/", (req, res) => res.send("AFC API is running"));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
