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

async function getUnbuiltVersions({
  datasource,
  lookupName,
  versionScheme,
  startVersion,
  ignoredVersions,
  image,
}) {
  console.log('Looking up versions');
  const ver = versioning.get(versionScheme);
  const rubyVersions = (await getPkgReleases({
    datasource,
    lookupName,
    versionScheme,
  })).releases
    .map(v => v.version)
    .filter(v => !ver.isLessThanRange(v, startVersion))
    .filter(v => !ignoredVersions.includes(v));
  const unbuiltVersions = [];
  for (const version of rubyVersions) {
    if (!(await tagExists(image, version))) {
      unbuiltVersions.push(version);
    }
  }
  if (unbuiltVersions.length) {
    console.log('Unbuilt versions: ' + unbuiltVersions.join(' '));
  } else {
    console.log('No unbuilt versions');
  }
  return unbuiltVersions;
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

async function buildAndPush({ image, buildArg }, versions) {
  let built = [];
  let failed = [];
  for (const version of versions) {
    const imageVersion = `${image}:${version}`;
    console.log(`Building ${imageVersion}`);
    let buildArgs;
    if (buildArg)
      try {
        await docker(
          `build --build-arg ${buildArg}=${version} . -t ${imageVersion}`
        );
        await docker(`push ${imageVersion}`);
        console.log(`Built ${imageVersion}`);
        built.push(version);
      } catch (err) {
        console.log(err);
        failed.push(version);
      }
  }
  if (built.length) {
    console.log('built: ' + built.join(' '));
  }
  if (built.length) {
    console.log('failed: ' + failed.join(' '));
    process.exit(-1);
  }
}

async function generateImages(config) {
  const unbuiltVersions = await getUnbuiltVersions(config);
  await buildAndPush(config, unbuiltVersions);
}

(async () => {
  const config = {
    datasource: process.env.DATASOURCE,
    lookupName: process.env.LOOKUP_NAME,
    versionScheme: process.env.VERSION_SCHEME,
    startVersion: process.env.START_VERSION,
    image: process.env.IMAGE,
    buildArg:
      process.env.BUILD_ARG || process.env.IMAGE.toUpperCase + '_VERSION',
    ignoredVersions: process.env.IGNORED_VERSIONS
      ? process.env.IGNORED_VERSIONS.split(',')
      : [],
  };
  await generateImages(config);
})();
