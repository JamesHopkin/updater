
import {execFile} from 'child_process';
import * as util from 'util';

const p4exe = process.platform === 'win32'? 'p4.exe' : 'p4';
const ztag_group_rex = /\n\n\.\.\.\s/;
const ztag_field_rex = /(?:\n|^)\.\.\.\s/;
const newline_rex = /\r\n|\n|\r/g;
const integer_rex = /^[1-9][0-9]*\s*$/;

// parse the perforce tagged output format into an array of objects
// TODO: probably should switch this to scrape Python dictionary format (-G) since ztag is super inconsistent with multiline fields
function parseZTag(buffer: string, multiLine?: boolean) {
	let output = [];

	// check for error lines ahead of the first ztag field
	let ztag_start = buffer.indexOf('...');
	if (ztag_start > 0)
	{
		// split the start off the buffer, then split it into newlines
		let preamble = buffer.substr(0, ztag_start).trim();
		output.push(preamble.split(newline_rex));
		buffer = buffer.substr(ztag_start);
	}
	else if (ztag_start < 0)
	{
		let preamble = buffer.trim();
		if (preamble.length > 0)
			output.push(preamble.split(newline_rex));
		buffer = "";
	}

	// split into groups
	let groups = buffer.split(ztag_group_rex);
	for (let i=0;i<groups.length;++i)
	{
		// make an object for each group
		let group: any = {};
		let text: string[] = [];

		// split fields
		let pairs = groups[i].split(ztag_field_rex);
		if (pairs[0] === "") {
			pairs.shift();
		}

		let setValue = false;
		for (let j=0;j<pairs.length;++j) {
			// each field is a key-value pair
			let pair = pairs[j].trim();
			if (pair === "")
				continue;

			let key, value;
			let s = pair.indexOf(' ');
			if (s >= 0)
			{
				key = pair.substr(0, s);
				value = pair.substr(s+1);
				if (value.indexOf('\n') >= 0 && !multiLine)
				{
					let lines = value.split('\n');
					value = lines.shift();
					text = text.concat(lines.filter((str) => { return str !== ""; }));
				}

				// if it's an integer, convert
				if (value.match(integer_rex))
					value = parseInt(value);
			}
			else
			{
				key = pair;
				value = true;
			}

			// set it on the group
			group[key] = value;
			setValue = true;
		}

		// if we have no values, omit this output
		if (!setValue)
			continue;

		// set to output
		output.push(group);

		// if we have raw text, add it at the end
		if (text.length > 0)
			output.push(text);
	}

	// temporarily log all ztag output
	//console.log("Temp ZTAG Log: ", output);
	return output;
}

class CommandRecord {
	constructor(public cmd: string, public start: Date = new Date())
	{
	}
}

interface Change {
	change: number
}


// P4 control object (contains some state like client)
// this class serializes all P4 commands sent to it.
export class Perforce {
	running = new Set<CommandRecord>();
	verbose = false;
	username = <string>null;

	// check if we are logged in and p4 is set up correctly
	async start() {
		const output = await this._execP4Async(null, ["-ztag", "login", "-s"]);
		let resp = parseZTag(output).shift();
		this.username = resp['User'] || false;
		return resp;
	}

	// get a list of changes in a path since a specific CL
	// output format is list of changelists
	async latestChange(path: string) {
		const result = await this.changes(path, 0, 1);
		return <Change>(result && result.length > 0 ? result[0] : null);
	}

	async changes(path_in: string, since: number, limit: number) {
		const path = since > 0 ? path_in + '@>' + since : path_in;
		const args = ['-ztag', 'changes', '-ssubmitted'];
		if (limit) {
			args.push('-m' + limit);
		}
		args.push(path);
		const output = await this._execP4Async(null, args, null, true);
		return <Change[]>parseZTag(output, true);
	}

	// sync the depot path specified
	async sync(workspace: string, depotPath: string, force?: boolean) {
		const args = ['sync'];
		if (force) {
			args.push('-f');
		}
		args.push(depotPath);
		try
		{
			await this._execP4Async(workspace, args);
		}
		catch ([err, output])
		{
			// this is an acceptable non-error case for us
			if (!output.trim().endsWith("up-to-date."))
				throw new Error(err);
		}
	}

	static getRootDirectoryForBranch(name: string) {
		return process.platform === "linux" ? `/src/${name}` : `D:/ROBO/${name}`;
	}

	// create a new CL with a specific description
	// output format is just CL number
	async new_cl(workspace: string, description: string, files?: string[]) {
		// build the minimal form
		let form = "Change:\tnew\nStatus:\tnew\nType:\tpublic\n";
		if (workspace)
			form += "Client:\t"+workspace+"\n";

		if (files) {
			form += "Files:\n";
			for (let filename of files) {
				form += "\t"+filename+"\n";
			}
		}
		form += "Description:\n\t" + this._sanitizeDescription(description);

		// run the P4 change command
		util.log("Executing: 'p4 change -i' to create a new CL");
		const output = await this._execP4Async(workspace, ["change", "-i"], form, true);
		// parse the CL out of output
		let m = output.match(/Change (\d+) created./);
		if (!m) 
			throw new Error("Unable to parse new_cl output:\n" + output);

		// return the changelist number
		return parseInt(m[1]);
	}

	// submit a CL
	// output format is final CL number or false if changes need more resolution
	async submit(workspace: string, changelist: number) {
		let output;
		try {
			output = await this._execP4Async(workspace, ["-ztag", "submit", "-f", "submitunchanged", "-c", changelist.toString()]);
		}
		catch ([err, output]) {
			let out = output.trim();
			if (out.startsWith("Merges still pending --")) {
				// concurrent edits (try again)
				return 0;
			}
			else if (out.startsWith("Out of date files must be resolved or reverted")) {
				// concurrent edits (try again)
				return 0;
			}
			else if (out.startsWith("No files to submit.")) {
				await this.delete_cl(workspace, changelist);
				return 0;
			}
			throw new Error(err);
		}

		// success, parse the final CL
		let result = parseZTag(output);
		let final = result.pop();
		let final_cl = final ? final.submittedChange : 0;
		if (final_cl) {
			// return the final CL
			return final_cl;
		}

		throw new Error("Unable to find submittedChange in P4 results:\n"+output);
	}

	// delete a CL
	// output format is just error or not
	delete_cl(workspace: string, changelist: number) {
		return this._execP4Async(workspace, ["change", "-d", changelist.toString()]);
	}

	// revert a CL deleting any files marked for add
	// output format is just error or not
	async revert(workspace: string, changelist: number) {
		// look out for -w causing ENOENT
		try {
			await this._execP4Async(workspace, ['revert', '-w', '-c', changelist.toString(), '//...']);
		}
		catch ([err, output]) {
			if (err) {
				// this happens if there's literally nothing in the CL. consider this a success
				if (output.match(/file\(s\) not opened on this client./))
					return;
				throw new Error(err);
			}
		}
	}

	async edit(workspace: string, cl: number, filePath: string) {
		return this._execP4Async(workspace, ['edit', '-c', cl.toString(), filePath]);
	}

	private _sanitizeDescription(description: string) {
		return description.trim().replace(/\n\n\.\.\.\s/g, "\n\n ... ").replace(/\n/g, "\n\t");
	}

	// execute a perforce command
	private _execP4(workspace: string, args: string[], stdin: string, callback: (err:Error, output?:string) => void, quiet?: boolean) {
		// add the client explicitly if one is set (should be done at call time)

		if (workspace) {
			args = ['-c', workspace].concat(args);
		}

		// log what we're running
		let cmd_rec = new CommandRecord('p4 ' + args.join(' '));
		if (!quiet || this.verbose)
			util.log("Executing: " + cmd_rec.cmd);
		this.running.add(cmd_rec);

		// we need to run within the workspace directory so p4 selects the correct AltRoot
		let options: any = { maxBuffer: 100*1024*1024 };
		if (workspace && process.platform === "linux") {
			options.cwd = '/src/' + workspace;
		}

		// run the child process
		let child = execFile(p4exe, args, options, (err, stdout, stderr) => {
			if (this.verbose)
				util.log("Command Completed: " + cmd_rec.cmd);
			this.running.delete(cmd_rec);

			// run the callback
			if (stderr) {
				let errstr = "P4 Error: "+cmd_rec.cmd+"\n";
				errstr += "STDERR:\n"+stderr+"\n";
				errstr += "STDOUT:\n"+stdout+"\n";
				if (stdin)
					errstr += "STDIN:\n"+stdin+"\n";
				callback(new Error(errstr), stderr.toString().replace(newline_rex, '\n'));
			}
			else if (err) {
				util.log(err.toString());
				let errstr = "P4 Error: "+cmd_rec.cmd+"\n"+err.toString()+"\n";

				if (stdout || stderr)
				{
					if (stdout)
						errstr += "STDOUT:\n"+stdout+"\n";
					if (stderr)
						errstr += "STDERR:\n"+stderr+"\n";
				}

				if (stdin)
					errstr += "STDIN:\n"+stdin+"\n";

				callback(new Error(errstr), stdout ? stdout.toString() : '');
			}
			else {
				callback(null, stdout.toString().replace(newline_rex, '\n'));
			}
		});

		// write some stdin if requested
		if (stdin) {
			try {
				child.stdin.write(stdin);
				child.stdin.emit('end');
			}
			catch (ex) {
				// usually means P4 process exited immediately with an error, which should be logged above
				console.log(ex);
			}
		}
	};

	async _execP4Async(workspace: string, args: string[], stdin?: string, quiet?: boolean): Promise<any> {
		return new Promise((done, fail) => {
			this._execP4(workspace, args, stdin, (err, result) =>
				err ? fail([err, result]) : done(result)
			, quiet);
		});
	}
}
