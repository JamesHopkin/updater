
import * as util from 'util';
import * as fs from 'fs';
import {Perforce} from './perforce';

process.on('unhandledRejection', err => {
	throw err;
});

const p4 = new Perforce();

const _readFile = util.promisify(fs.readFile);
const _writeFile = util.promisify(fs.writeFile);

// use custom workspace to sync in a particular place? - exclude bin!
const WORKSPACE = 'JAMES_HOPKIN_ROBOMERGE_TEST_Robomerge';
const DEPOT = '//GamePlugins/Main/Programs/Robomerge';
const VERSION_FILE_NAME = 'version.json'

// will set up workspace so it just maps to Robomerge
const VERSION_FILE_PATH = `D:/Robo/${WORKSPACE}/Programs/Robomerge/${VERSION_FILE_NAME}`;

function init() {
	return p4.start();
}

interface Version {
	build: number,
	cl: number
}

async function build() {
	const DEPOT_RECURSIVE = DEPOT + '/...';
	const latestChange = await p4.latestChange(DEPOT_RECURSIVE);
	// await p4.sync(WORKSPACE, `${DEPOT_RECURSIVE}@${latestChange.change}`, true);
	util.log('sunk!' + latestChange.change);

	const versionBuf = await _readFile(VERSION_FILE_PATH);
	const version = <Version>JSON.parse(versionBuf.toString());

	version.build = version.build + 1;
	version.cl = latestChange.change;

	const cl = await p4.new_cl(WORKSPACE, `ROBO_DEPLOY: Updated version file for build ${version.build}`);
	await p4.edit(WORKSPACE, cl, DEPOT + '/version.json');
	await _writeFile(VERSION_FILE_PATH, JSON.stringify(version, null, 2));
}

init().then(build);
