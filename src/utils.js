const config = require('config');
const dict = require('dicom-data-dictionary');
const dimse = require('dicom-dimse-native');
const simpleLogger = require('simple-node-logger');
const shell = require('shelljs');
const storage = require('node-persist');
const path = require('path');
const fs = require('fs');
const throat = require('throat')(config.get('maxAssociations'));

const lock = new Map();

// make sure default directories exist
const logDir = config.get('logDir');
shell.mkdir('-p', logDir);
shell.mkdir('-p', config.get('storagePath'));

// create a rolling file logger based on date/time that fires process events
const opts = {
  errorEventName: 'error',
  logDirectory: logDir, // NOTE: folder must exist and be writable...
  fileNamePattern: 'roll-<DATE>.log',
  dateFormat: 'YYYY.MM.DD',
};
const manager = simpleLogger.createLogManager();
// manager.createConsoleAppender();
manager.createRollingFileAppender(opts);
const logger = manager.createLogger();

const QUERY_LEVEL = Object.freeze({ STUDY: 1, SERIES: 2, IMAGE: 3 });

//------------------------------------------------------------------

const findDicomName = (name) => {
  // eslint-disable-next-line no-restricted-syntax
  for (const key of Object.keys(dict.standardDataElements)) {
    const value = dict.standardDataElements[key];
    if (value.name === name) {
      return key;
    }
  }
  return undefined;
};

//------------------------------------------------------------------

// helper to add minutes to date object
const addMinutes = (date, minutes) => {
  const ms = date.getTime() + minutes * 60000;
  return new Date(parseInt(ms, 10));
};

//------------------------------------------------------------------

const getLockUid = (studyUid, seriesUid, imageUid, level) => {
  if (level === 'STUDY') return studyUid;
  if (level === 'SERIES') return seriesUid;
  if (level === 'IMAGE') return imageUid;

  logger.warn('getLockUid, level not found: ', level);
  return seriesUid;
};

//------------------------------------------------------------------

const getQueryLevel = (level) => {
  if (level === 'STUDY') return QUERY_LEVEL.STUDY;
  if (level === 'SERIES') return QUERY_LEVEL.SERIES;
  if (level === 'IMAGE') return QUERY_LEVEL.IMAGE;

  logger.warn('getQueryLevel, level not found: ', level);
  return QUERY_LEVEL.SERIES;
};

//------------------------------------------------------------------

const queryLevelToString = (qlevel) => {
  switch (qlevel) {
    case 1:
      return 'STUDY';
    case 2:
      return 'SERIES';
    case 3:
      return 'IMAGE';
    default:
      logger.warn('queryLevelToString, level not found: ', qlevel);
      return 'SERIES';
  }
};

//------------------------------------------------------------------

const queryLevelToPath = (studyUid, seriesUid, imageUid, qlevel) => {
  switch (qlevel) {
    case 1:
      return studyUid;
    case 2:
      return `${studyUid}/${seriesUid}`;
    case 3:
      return `${studyUid}/${seriesUid}/${imageUid}`;
    default:
      logger.warn('queryLevelToPath, level not found: ', qlevel);
      return `${studyUid}/${seriesUid}`;
  }
};

//------------------------------------------------------------------

// remove cached data if outdated
const clearCache = (storagePath, currentUid) => {
  const currentDate = new Date();
  storage.forEach((item) => {
    const dt = new Date(item.value);
    const directory = path.join(storagePath, item.key);
    if (dt.getTime() < currentDate.getTime() && item.key !== currentUid) {
      logger.info(`cleaning directory: ${directory}`);
      fs.rm(
        directory,
        {
          recursive: true,
        },
        (error) => {
          if (error) {
            logger.error(error);
          } else {
            logger.info('deleted: ', directory);
            storage.rm(item.key); // not nice but seems to work
          }
        }
      );
    }
  });
};

//------------------------------------------------------------------

// request data from PACS via c-get or c-move
const fetchData = async (studyUid, seriesUid, imageUid, level) => {
  const lockId = getLockUid(studyUid, seriesUid, imageUid, level);
  const queryLevel = getQueryLevel(level);
  const queryLevelString = queryLevelToString(queryLevel);

  // add query retrieve level and fetch whole study
  const j = {
    tags: [
      {
        key: '00080052',
        value: queryLevelString,
      },
      {
        key: '0020000D',
        value: studyUid,
      },
    ],
  };

  if (queryLevel >= QUERY_LEVEL.SERIES) {
    j.tags.push({
      key: '0020000E',
      value: seriesUid,
    });
  }

  if (queryLevel >= QUERY_LEVEL.IMAGE) {
    j.tags.push({
      key: '00080018',
      value: imageUid,
    });
  }

  // set source and target from config
  const ts = config.get('transferSyntax');
  j.netTransferPrefer = ts;
  j.netTransferPropose = ts;
  j.writeTransfer = ts;
  j.source = config.get('source');
  j.target = config.get('target');
  j.verbose = config.get('verboseLogging');
  j.storagePath = config.get('storagePath');

  const scu = config.get('useCget') ? dimse.getScu : dimse.moveScu;
  const uidPath = queryLevelToPath(studyUid, seriesUid, imageUid, queryLevel);
  const cacheTime = config.get('keepCacheInMinutes');

  const prom = new Promise((resolve, reject) => {
    try {
      logger.info(`fetch start: ${uidPath}`);
      clearCache(j.storagePath, studyUid);
      scu(JSON.stringify(j), (result) => {
        if (result && result.length > 0) {
          try {
            const json = JSON.parse(result);
            if (json.code === 0 || json.code === 2) {
              logger.info(`fetch finished: ${uidPath}`);
              storage
                .getItem(studyUid)
                .then((item) => {
                  if (!item) {
                    if (cacheTime >= 0) {
                      const minutes = addMinutes(new Date(), cacheTime);
                      if (studyUid && minutes) {
                        storage.setItem(studyUid, minutes);
                      }
                    }
                  }
                })
                .catch((e) => {
                  logger.error(e);
                });
              resolve(result);
            } else {
              logger.info(JSON.parse(result));
            }
          } catch (error) {
            reject(error, result);
          }
          lock.delete(lockId);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
  // store in lock
  lock.set(lockId, prom);
  return prom;
};

//------------------------------------------------------------------

const utils = {
  getLogger() {
    return logger;
  },

  async init() {
    const persistPath = path.join(config.get('storagePath'), 'persist');
    await storage.init({ dir: persistPath });
  },

  async startScp() {
    const ts = config.get('transferSyntax');
    const j = {};
    j.source = config.get('source');
    j.storagePath = config.get('storagePath');
    j.verbose = config.get('verboseLogging');
    j.netTransferPrefer = ts;
    j.netTransferPropose = ts;
    j.writeTransfer = ts;
    j.peers = [config.get('target')];
    j.permissive = true;

    logger.info(`pacs-server listening on port: ${j.source.port}`);

    dimse.startScp(JSON.stringify(j), (result) => {
      // currently this will never finish
      logger.info(JSON.parse(result));
    });
  },

  async shutdown() {
    const j = {};
    j.source = config.get('source');
    j.target = config.get('source');
    j.verbose = config.get('verboseLogging');

    logger.info(`sending shutdown request to target: ${j.target.aet}`);

    return new Promise((resolve, reject) => {
      dimse.shutdownScu(JSON.stringify(j), (result) => {
        if (result && result.length > 0) {
          try {
            logger.info(JSON.parse(result));
            resolve();
          } catch (error) {
            logger.error(result);
            reject();
          }
        }
        reject();
      });
    });
  },

  async sendEcho() {
    const j = {};
    j.source = config.get('source');
    j.target = config.get('target');
    j.verbose = config.get('verboseLogging');

    logger.info(`sending C-ECHO to target: ${j.target.aet}`);

    return new Promise((resolve, reject) => {
      dimse.echoScu(JSON.stringify(j), (result) => {
        if (result && result.length > 0) {
          try {
            logger.info(JSON.parse(result));
            resolve();
          } catch (error) {
            logger.error(result);
            reject();
          }
        }
        reject();
      });
    });
  },

  async waitOrFetchData(studyUid, seriesUid, imageUid, level) {
    const lockId = getLockUid(studyUid, seriesUid, imageUid, level);

    // check if already locked and return promise
    if (lock.has(lockId)) {
      return lock.get(lockId);
    }

    return throat(async () => {
      await fetchData(studyUid, seriesUid, imageUid, level);
    });
  },

  fileExists(pathname) {
    return new Promise((resolve, reject) => {
      fs.access(pathname, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  },

  compressFile(inputFile, outputDirectory, transferSyntax) {
    const j = {
      sourcePath: inputFile,
      storagePath: outputDirectory,
      writeTransfer: transferSyntax || config.get('transferSyntax'),
      verbose: config.get('verboseLogging'),
    };

    // run find scu and return json response
    return new Promise((resolve, reject) => {
      dimse.recompress(JSON.stringify(j), (result) => {
        if (result && result.length > 0) {
          try {
            const json = JSON.parse(result);
            if (json.code === 0) {
              resolve();
            } else {
              logger.error(`recompression failure (${inputFile}): ${json.message}`);
              reject();
            }
          } catch (error) {
            logger.error(error);
            logger.error(result);
            reject();
          }
        } else {
          logger.error('invalid result received');
          reject();
        }
      });
    });
  },

  studyLevelTags() {
    return [
      '00080005',
      '00080020',
      '00080030',
      '00080050',
      '00080054',
      '00080056',
      '00080061',
      '00080090',
      '00081190',
      '00100010',
      '00100020',
      '00100030',
      '00100040',
      '0020000D',
      '00200010',
      '00201206',
      '00201208',
    ];
  },

  seriesLevelTags() {
    return ['00080005', '00080054', '00080056', '00080060', '0008103E', '00081190', '0020000E', '00200011', '00201209'];
  },

  imageLevelTags() {
    return ['00080016', '00080018'];
  },

  async doFind(queryLevel, query, defaults) {
    // add query retrieve level
    const j = {
      tags: [
        {
          key: '00080052',
          value: queryLevel,
        },
      ],
    };

    // set source and target from config
    j.source = config.get('source');
    j.target = config.get('target');
    j.verbose = config.get('verboseLogging');

    // parse all include fields
    const includes = query.includefield;

    let tags = [];
    if (includes) {
      tags = includes.split(',');
    }
    tags.push(...defaults);

    // add parsed tags
    tags.forEach((element) => {
      const tagName = findDicomName(element) || element;
      j.tags.push({ key: tagName, value: '' });
    });

    // add search param
    let isInValidInput = false;
    Object.keys(query).forEach((propName) => {
      const tag = findDicomName(propName);
      if (tag) {
        let v = query[propName];
        // patient name check
        if (tag === '00100010') {
          // check if minimum number of chars for patient name are given
          if (v.length < config.get('qidoMinChars')) {
            isInValidInput = true;
          }
          // auto append wildcard
          if (config.get('qidoAppendWildcard')) {
            v += '*';
          }
        }
        j.tags.push({ key: tag, value: v });
      }
    });
    // return with empty results if invalid
    if (isInValidInput) {
      return [];
    }

    const offset = query.offset ? parseInt(query.offset, 10) : 0;

    // run find scu and return json response
    return new Promise((resolve) => {
      dimse.findScu(JSON.stringify(j), (result) => {
        if (result && result.length > 0) {
          try {
            const json = JSON.parse(result);
            if (json.code === 0) {
              const container = JSON.parse(json.container);
              if (container) {
                resolve(container.slice(offset));
              } else {
                resolve([]);
              }
            } else if (json.code === 1) {
              logger.info('query is pending...');
            } else {
              logger.error(`c-find failure: ${json.message}`);
              resolve([]);
            }
          } catch (error) {
            logger.error(error);
            logger.error(result);
            resolve([]);
          }
        } else {
          logger.error('invalid result received');
          resolve([]);
        }
      });
    });
  },
  async doWadoUri(query) {
    const fetchLevel = config.get('useFetchLevel');
    const studyUid = query.studyUID;
    const seriesUid = query.seriesUID;
    const imageUid = query.objectUID;
    if (!studyUid || !seriesUid || !imageUid) {
      const msg = `Error missing parameters.`;
      logger.error(msg);
      throw msg;
    }
    const storagePath = config.get('storagePath');
    const studyPath = path.join(storagePath, studyUid);
    const pathname = path.join(studyPath, imageUid);

    try {
      await utils.fileExists(pathname);
    } catch (error) {
      try {
        await utils.waitOrFetchData(studyUid, seriesUid, imageUid, fetchLevel);
      } catch (e) {
        logger.error(e);
        const msg = `fetch failed`;
        throw msg;
      }
    }

    try {
      await utils.fileExists(pathname);
    } catch (error) {
      logger.error(error);
      const msg = `file not found ${pathname}`;
      throw msg;
    }

    try {
      await utils.compressFile(pathname, studyPath);
    } catch (error) {
      logger.error(error);
      const msg = `failed to compress ${pathname}`;
      throw msg;
    }

    // read file from file system
    const fsPromise = fs.promises;
    try {
      return fsPromise.readFile(pathname);
    } catch (error) {
      logger.error(error);
      const msg = `failed to read ${pathname}`;
      throw msg;
    }
  },
};
module.exports = utils;
