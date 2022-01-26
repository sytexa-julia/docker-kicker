const express = require("express");
const fs = require("fs");
const Docker = require("dockerode");
const crypto = require("crypto");
const Ipware = require("@fullerstack/nax-ipware");
const ipware = new Ipware.Ipware();

const logger = require("pino")({
  level: "debug",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  },
});

/**
 * @typedef Auth
 * @property {string} username
 * @property {string} password
 * @property {string} email
 * @property {string} serveraddress
 */

class ConfigEntry {
  /**
   * Create a new configuration entry.
   * @param {Object} conf
   * @param {string} conf.name
   * @param {string} conf.key
   * @param {string} conf.image
   * @param {Auth} conf.auth
   * @param {string[]} [conf.queryParamsToEnv=[]]
   * @param {string[]?} [conf.allowFrom=["127.0.0.1", "::1"]]
   * @param {string[]?} [conf.cmd=[]]
   * @param {Object?} [conf.createOptions={}]
   * @param {number} [conf.limit=1]
   */
  constructor(conf) {
    this._name = conf.name;
    this._key = conf.key;
    this._image = conf.image;
    this._auth = conf.auth;
    this._queryParamsToEnv = conf.queryParamsToEnv || [];
    this._allowFrom = conf.allowFrom || ["127.0.0.1", "::1"];
    this._cmd = conf.cmd || [];
    this._createOptions = conf.createOptions || {};
    this._limit = conf.limit || 1;
  }

  /**
   * The name of the configuration as provided without replace non-alphanumeric characters.
   * @private
   * @type {string}
   */
  get _rawName() {
    return this._name;
  }

  /**
   * Unique name for the configuration.
   * All non-alphanumeric characters are replaced with dashes
   * @type {string}
   */
  get name() {
    return cleanConfigName(this._name);
  }

  /**
   * @type {string}
   */
  get key() {
    return this._key;
  }

  /**
   * @type {string[]}
   */
  get allowFrom() {
    return this._allowFrom;
  }

  /**
   * @type {string}
   */
  get image() {
    return this._image;
  }

  /**
   * @type {Auth}
   */
  get auth() {
      return this._auth;
  }

  /**
   * @type {string[]}
   */
  get cmd() {
    return this._cmd;
  }

  /**
   * @type {string[]}
   */
  get queryParamsToEnv() {
    return this._queryParamsToEnv;
  }

  /**
   * @type {Object}
   */
  get createOptions() {
    return this._createOptions;
  }

  /**
   * @type {number}
   */
  get limit() {
    return this._limit;
  }
}

let docker, config;

/**
 * Replace all non-alphanumeric characters in the given name with dashes (-)
 * @param {string} name
 * @returns {string} Cleaned name
 */
function cleanConfigName(name) {
  return name.replace(/[\W_]+/g, "-");
}
/**
 * Attempt to validate the provided configuration. Throws if there is an issue.
 * @param {ConfigEntry[]} configArray
 */
function tryValidateConfig(configArray) {
  configArray.forEach((curr) => {
    if (!curr.name) {
      throw "Missing config name.";
    }
    if (!curr.key) {
      throw `Missing key for config '${curr.name}'`;
    }
    if (curr.key.length < 50) {
      logger.warn("Key for config '%s' is < 50 chars long", curr.name);
    }
    if (!curr.image) {
      throw `Missing image for config '${curr.name}'`;
    }
  });

  // names must be unique
  const allNames = configArray.map((curr) => curr.name);
  if (Array.from(new Set(allNames)).length !== allNames.length) {
    throw "Configuration entry names must be unique.";
  }
  // keys must be unique
  const allKeys = configArray.map((curr) => curr.key);
  if (Array.from(new Set(allKeys)).length !== allKeys.length) {
    throw "Configuration entry keys must be unique.";
  }

  logger.info("Configuration appears to be valid");
}

/**
 * Key is the generated name of the running container instance.
 * @type {Map<string,string[]}>}
 */
let runningMap = new Map();

/**
 * @param {ConfigEntry} configEntry
 * @returns Unique instance name for the container run
 */
function genNewInstanceName(configEntry) {
  let rootName = configEntry.name;
  let uniq = crypto.randomUUID();
  return `${rootName}_${uniq}`;
}

/**
 * Try adding a container instance to tracking. Checks if the configured run limit is exceeded.
 * @param {ConfigEntry} config
 * @param {string} instanceName
 * @returns {boolean} true if running a new instance is allowed; false if the configured limit is exceeded
 */
function tryTrackNewRunningInstance(config, instanceName) {
  if (runningMap.has(config.name)) {
    let alreadyRunning = runningMap.get(config.name);
    if (alreadyRunning.length >= config.limit) {
      return false;
    }
    alreadyRunning.push(instanceName);
  } else {
    runningMap.set(config.name, [instanceName]);
  }

  return true;
}

/**
 * Remove a container instance from tracking (because it has finished executing and been removed).
 * @param {ConfigEntry} config
 * @param {string} instanceName
 */
function untrackRunningInstance(config, instanceName) {
  let alreadyRunning = runningMap.get(config.name);
  if (alreadyRunning && alreadyRunning.length) {
    alreadyRunning.splice(alreadyRunning.indexOf(instanceName));
  }
}

/**
 * Extract allowlisted query parameters into environment variable format.
 * @param {ConfigEntry} config
 * @param {Object} query
 * @returns {string[]}
 */
function extractAllowedQueryParams(config, query) {
  return config.queryParamsToEnv
    .filter((key) => key in query)
    .map((key) => `${key}=${decodeURIComponent(query[key])}`);
}

// Configure app
const app = express();

// Status endpoint
app.get("/", (req, res) => {
  res.status(200).end();
});

// Kicker endpoint
app.post("/:key", function (req, res) {
  const key = req.params.key;

  const match = config.find((e) => e.key === key);
  if (!match) {
    res.status(400).end();
    return;
  }

  const ipInfo = ipware.getClientIP(req, {
    proxy: connectConfig.proxy,
  });
  logger.info("Computed client IP: %s", ipInfo?.ip)

  const clientIp = ipInfo?.ip ?? req.ip
  if (
    (match.allowFrom &&
      typeof match.allowFrom === "string" &&
      match.allowFrom !== clientIp) ||
    (Array.isArray(match.allowFrom) &&
      !match.allowFrom.some((af) => af === clientIp))
  ) {
    logger.warn("Rejecting kick request from %s", clientIp);
    res.status(403).end();
    return;
  }

  logger.info(
    "Kicking %s / %s via web request from %s",
    match.name,
    match.cmd,
    clientIp
  );

  // Add any query-to-env vars to env
  const queryToEnvVars = extractAllowedQueryParams(match, req.query);

  logger.debug("allowed query params: %s", match.queryParamsToEnv);
  logger.debug("extracted query params: %s", queryToEnvVars);

  if (queryToEnvVars) {
    let env = [...(match.createOptions?.env ?? []), ...queryToEnvVars];

    if (match.createOptions) {
      match.createOptions.env = env;
    } else {
      match.createOptions = { env };
    }
  }

  // Transform create options
  let createOptions = {
    name: genNewInstanceName(match),
    ...match.createOptions,
  };

  logger.debug({ createOptions });

  try {
    // Pull latest image down
    docker.pull(match.image, {authconfig: match.auth}).then(function () {
      logger.info("Running instance %s", createOptions.name);

      if (!tryTrackNewRunningInstance(match, createOptions.name)) {
        logger.warn(
          "Limit for configuration %s reached; will not kick.",
          config.name
        );
        res.status(429).end();
        return;
      }

      // Run the container
      docker
        .run(match.image, match.cmd, process.stdout, createOptions)
        .then(function (data) {
          var output = data[0];
          var container = data[1];
          logger.debug({ output });
          return container.remove();
        })
        .then(function (data) {
          untrackRunningInstance(match, createOptions.name);
          logger.info("Container %s removed", createOptions.name);
        })
        .catch(function (err) {
          untrackRunningInstance(match, createOptions.name);
          logger.error(err);
        });
    });
  } catch (err) {
    logger.error(err);
  }

  res.status(200).end();
});

// Startup
// Read connection info
let connectConfig
fs.readFile(
  process.env.KICKER_CONNECTCONFIG || "connect-config.json",
  "utf8",
  function (err, data) {
    connectConfig = JSON.parse(data);
    docker = new Docker(connectConfig.docker);

    // Proxy
    //app.use(function (req, res, next) {
    //  req.ipInfo = ipware.getClientIP(req, {
    //    proxy: connectConfig.proxy,
    //  });
    //  logger.info("ipWareResult: %s", req.ipInfo?.ip)
    //  next();
    //});

    // Read configuration
    fs.readFile(
      process.env.KICKER_CONFIG || "kicker-config.json",
      "utf8",
      function (err, data) {
        const configRaw = JSON.parse(data);
        if (!Array.isArray(configRaw)) {
          throw "Invalid config.";
        }

        config = configRaw.map((r) => new ConfigEntry(r));
        tryValidateConfig(config);

        // Everything seems to be working... start listening...
        const port = process.env.KICKER_PORT || 41331;

        app.listen(port, () => {
          logger.info(`Docker Kicker listening on port ${port}`);
        });
      }
    );
  }
);
