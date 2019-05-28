#! /usr/bin/env node

const got = require('got');
const os = require('os');
const { getPkgReleases } = require('renovate/dist/datasource');
const { initLogger } = require('renovate/dist/logger');
const cache = require('renovate/dist/workers/global/cache');
const versioning = require('renovate/dist/versioning');
const { spawn } = require('child_process');

initLogger();

if (!global.renovateCache) {
  cache.init(os.tmpdir());
}

global.repoCache = {};

async function tagExists(image, version) {
  const url = `https://index.docker.io/v1/repositories/renovate/${image}/tags/${version}`;
  try {
    await got(url);
    return true;
  } catch (err) {
    return false;
  }
}

async function getBuildList({
  datasource,
  lookupName,
  versionScheme,
  startVersion,
  ignoredVersions,
  latestOnly,
  force,
  image,
}) {
  console.log('Looking up versions');
  const ver = versioning.get(versionScheme);
  let allVersions = (await getPkgReleases({
    datasource,
    lookupName,
    versionScheme,
  })).releases.map(v => v.version);
  console.log(`Found ${allVersions.length} total versions`);
  if (!allVersions.length) {
    return [];
  }
  allVersions = allVersions
    .filter(v => !ver.isLessThanRange(v, startVersion))
    .filter(v => !ignoredVersions.includes(v));
  if (latestOnly) {
    console.log('Using latest version only');
    allVersions = [allVersions.pop()];
  }
  let buildList = [];
  if (force) {
    console.log('Force building all versions');
    buildList = allVersions;
  } else {
    for (const version of allVersions) {
      if (force || !(await tagExists(image, version))) {
        buildList.push(version);
      }
    }
  }
  if (buildList.length) {
    console.log('Build list: ' + buildList.join(' '));
  } else {
    console.log('Nothing to build');
  }
  return buildList;
}

async function docker(cmd) {
  console.log('docker ' + cmd);
  return new Promise((resolve, reject) => {
    let child = spawn('docker', cmd.split(' '));

    // Listen for outputs
    child.stdout.on('data', data => {
      console.log(`${data}`);
    });
    child.stderr.on('data', data => {
      console.error(`${data}`);
    });

    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject();
      }
    });
  });
}

async function buildAndPush({ image, buildArg, buildOnly }, versions) {
  let built = [];
  let failed = [];
  for (const version of versions) {
    const imageVersion = `${image}:${version}`;
    console.log(`Building ${imageVersion}`);
    if (buildArg)
      try {
        await docker(
          `build --build-arg ${buildArg}=${version} . -t ${imageVersion}`
        );
        if (!buildOnly) {
          await docker(`push ${imageVersion}`);
        }
        console.log(`Built ${imageVersion}`);
        built.push(version);
      } catch (err) {
        console.log(err);
        failed.push(version);
      }
  }
  if (built.length) {
    console.log('Build list: ' + built.join(' '));
  }
  if (failed.length) {
    console.log('Failed list: ' + failed.join(' '));
    process.exit(-1);
  }
}

async function generateImages(config) {
  const buildList = await getBuildList(config);
  await buildAndPush(config, buildList);
}

(async () => {
  const config = {
    datasource: process.env.DATASOURCE,
    lookupName: process.env.LOOKUP_NAME,
    versionScheme: process.env.VERSION_SCHEME,
    startVersion: process.env.START_VERSION,
    image: process.env.IMAGE,
    buildArg:
      process.env.BUILD_ARG || process.env.IMAGE.toUpperCase() + '_VERSION',
    ignoredVersions: process.env.IGNORED_VERSIONS
      ? process.env.IGNORED_VERSIONS.split(',')
      : [],
    buildOnly: !!process.env.BUILD_ONLY,
    latestOnly: !!process.env.LATEST_ONLY,
    force: !!process.env.FORCE,
  };
  if (
    process.env.CIRCLECI === 'true' &&
    process.env.CIRCLE_BRANCH !== 'master'
  ) {
    console.log('CircleCI branch detected - Force building latest, no push');
    config.buildOnly = true;
    config.latestOnly = true;
    config.force = true;
  }
  console.log(config);
  await generateImages(config);
})();
