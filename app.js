const express = require("express");
const Docker = require("dockerode");
const crypto = require("crypto");
const logger = require("pino")({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  },
});

const app = express();

const port = process.env.KICKER_PORT || 41331;
const connectConfig = JSON.parse(process.env.KICKER_DOCKERCONNECTCONFIG);
const docker = new Docker(connectConfig);

class ConfigEntry {
  /**
   *
   * @param {Object} conf
   * @param {string} conf.name
   * @param {string} conf.key
   * @param {string} conf.image
   * @param {string[]?} [conf.allowFrom=["127.0.0.1", "::1"]]
   * @param {string[]?} [conf.cmd=[]]
   * @param {Object?} [conf.createOptions={}]
   * @param {number} [conf.limit=1]
   */
  constructor(conf) {
    this._name = conf.name;
    this._key = conf.key;
    this._image = conf.image;
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
   * @type {string[]}
   */
  get cmd() {
    return this._cmd;
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

// Build config
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

  logger.info("Configuration appears to be valid");
}

const configData = process.env.KICKER_CONFIG;
const configRaw = JSON.parse(configData);
if (!Array.isArray(configRaw)) {
  throw "Invalid config.";
}

const config = configRaw.map((r) => new ConfigEntry(r));
tryValidateConfig(config);

/**
 * Key is the generated name of the running container instance.
 * @type {Map<string,string[]}>}
 */
let runningMap = new Map();

function genNewInstanceName(configEntry) {
  let rootName = configEntry.name;
  let uniq = crypto.randomUUID();
  return `${rootName}_${uniq}`;
}

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

function untrackRunningInstance(config, instanceName) {
  let alreadyRunning = runningMap.get(config.name);
  if (alreadyRunning && alreadyRunning.length) {
    alreadyRunning.splice(alreadyRunning.indexOf(instanceName));
  }
}

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
  if (
    (match.allowFrom &&
      typeof match.allowFrom === "string" &&
      match.allowFrom !== req.ip) ||
    (Array.isArray(match.allowFrom) &&
      !match.allowFrom.some((af) => af === req.ip))
  ) {
    logger.warn("Rejecting kick request from %s", req.ip);
    res.status(403).end();
    return;
  }

  logger.info(
    "Kicking %s / %s via web request from %s",
    match.name,
    match.cmd,
    req.ip
  );
  logger.debug(match);

  let createOptions = {
    name: genNewInstanceName(match),
    ...match.createOptions,
  };

  try {
    docker.pull(match.image).then(function () {
      logger.info("Running instance %s", createOptions.name);

      if (!tryTrackNewRunningInstance(match, createOptions.name)) {
        logger.warn(
          "Limit for configuration %s reached; will not kick.",
          config.name
        );
        res.status(429).end();
        return;
      }

      docker
        .run(match.image, match.cmd, process.stdout, createOptions)
        .then(function (data) {
          var output = data[0];
          var container = data[1];
          logger.debug(output.StatusCode);
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

app.listen(port, () => {
  logger.info(`Docker Kicker listening on port ${port}`);
});
