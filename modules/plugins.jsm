/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is DownThemAll! Anti-Container plugins module
 *
 * The Initial Developer of the Original Code is Nils Maier
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Nils Maier <MaierMan@web.de>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const EXPORTED_SYMBOLS = [
	'pushPlugin', 'popPlugin',
	'JSON',
	'loadPluginFromStream', 'loadPluginFromFile',
	'enumerate',
	'installFromFile', 'installFromWeb', 'uninstallPlugin',
	'TOPIC_PLUGINSCHANGED'
];

const Cc = Components.classes;
const Ci = Components.interfaces;
const log = Components.utils.reportError;

const TOPIC_PLUGINSCHANGED = 'DTA:AC:pluginschanged';
const DEFAULT_NAMESPACE = 'nonymous';

const ConverterOutputStream = Components.Constructor('@mozilla.org/intl/converter-output-stream;1', 'nsIConverterOutputStream', 'init');
const FileInputStream = Components.Constructor('@mozilla.org/network/file-input-stream;1', 'nsIFileInputStream', 'init');
const FileOutputStream = Components.Constructor('@mozilla.org/network/file-output-stream;1', 'nsIFileOutputStream', 'init');
const File = new Components.Constructor('@mozilla.org/file/local;1', 'nsILocalFile', 'initWithPath');

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

// lazy init some components we need
this.__defineGetter__('Prefs', function() {
	let p = Cc['@mozilla.org/preferences-service;1']
		.getService(Ci.nsIPrefService)
		.getBranch('extensions.dta.')
		.QueryInterface(Ci.nsIPrefBranch2);
	delete this.Prefs;
	return this.Prefs = p;
});

this.__defineGetter__('EM_DIR', function() {
	let ed = Cc['@mozilla.org/extensions/manager;1']
		.getService(Ci.nsIExtensionManager)
		.getInstallLocation('anticontainer@downthemall.net')
		.getItemFile('anticontainer@downthemall.net', 'plugins/');
	delete this.EM_DIR;
	return this.EM_DIR = ed;
});

this.__defineGetter__('PD_DIR', function() {
	let pd = Cc['@mozilla.org/file/directory_service;1']
		.getService(Ci.nsIProperties)
		.get("ProfD", Ci.nsILocalFile);
	delete this.PD_DIR;
	return this.PD_DIR = pd;
});


this.__defineGetter__('USER_DIR', function() {
	let d = PD_DIR.clone();
	d.append('anticontainer_plugins');
	if (!d.exists()) {
		d.create(Ci.nsIFile.DIRECTORY_TYPE, 0664);
	}
	delete this.USER_DIR;
	return this.USER_DIR = d;
});

this.__defineGetter__('JSON', function() {
	delete this.JSON;
	return this.JSON = Cc['@mozilla.org/dom/json;1'].createInstance(Ci.nsIJSON);
});

this.__defineGetter__('UUID', function() {
	let ug = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);
	delete this.UUID;
	return this.UUID = ug;
});
function newUUID() UUID.generateUUID().toString();

function Observer() {
	Prefs.addObserver('anticontainer.disabled_plugins', this, true);
	Prefs.addObserver('filters.deffilter-ac', this, true);
}
Observer.prototype = {
	_os: Cc['@mozilla.org/observer-service;1'].getService(Ci.nsIObserverService),
	QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference, Ci.nsIWeakReference]),
	QueryReferent: function(iid) this.QueryInterface(iid),
	GetWeakReference: function() this,
	
	observe: function() {
		this.notify();
	},
	notify: function() {
		this._os.notifyObservers(null, TOPIC_PLUGINSCHANGED, null);
	}
};
const observer = new Observer();

let lastFilters = 0;

function validatePlugin(o) {
	if (['redirector', 'resolver', 'sandbox'].indexOf(o.type) == -1) {
		throw new Error("Failed to load plugin: invalid type");
	}
	
	switch (o.type) {
	case 'resolver':
		if (!o.finder || !o.builder) {
			throw new Error("Failed to load plugin: incomplete resolver!");
		}
		break;
	case 'redirector':
		if (!o.pattern || !o.match) {
			throw new Error("Failed to load plugin: incomplete redirector!");
		}
		break;
	case 'sandbox':
		if (!o.process && !o.resolve) {
			throw new Error("Failed to load plugin: sandboxed plugin doesn't implement anything!");
		}
		break;
	}
	
	if (!o.prefix || typeof o.prefix != 'string') {
		throw new Error("Failed to load plugin: prefix omitted");
	}
	
	o.source = JSON.encode(o);
	
	for each (let x in ['match', 'finder', 'pattern']) {
		if (x in o) {
			o['str' + x] = o[x];
			o[x] = new RegExp(o[x], 'im');
		}
	}
	for each (let c in o.cleaners) {
		for each (let x in ['pattern']) {
			if (x in c) {
				c['str' + x] = c[x];
				c[x] = new RegExp(c[x], 'i');
			}
		}
	}
	for each (let b in ['static', 'decode', 'static', 'omitReferrer', 'sendInitialReferrer', 'useServerName']) {
		o[b] = !!o[b];
	}
	
	if (!o.priority || typeof o.priority != 'number') {
		o.priority = 0;
	}
	o.priority = Math.round(o.priority);
	
	if (!o.ns) {
		o.ns = DEFAULT_NAMESPACE;
	}
	o.ns = o.ns.toString();
	
	o.id = o.prefix + '@' + o.ns;
	return o;
}

/**
 * Loads a plugin directly from a nsIInputStream
 * @param stream Stream to load from
 * @param size Size to read from the Stream
 * @return Loaded plugin
 */
function loadPluginFromStream(stream, size) {
	return validatePlugin(JSON.decodeFromStream(stream, size));
}

/**
 * Loads a plugin from a file
 * @param file File to load the plugin from (either as String or nsIFile)
 * @return Loaded Plugin
 */
function loadPluginFromFile(file) {
	if (!(file instanceof Ci.nsIFile)) {
		file = new File(file);
	}
	let fs = new FileInputStream(file, 0x01, 0, 1<<2);
	let o = loadPluginFromStream(fs, file.size);
	fs.close();
	o.file = file;	
	return o;
}
function idToFilename(id) id.replace(/[^\w\d\._@-]/gi, '-') + ".json";

function _enumerate(enumerators, p) {
	if (!(p instanceof Array)) {
		p = [];
	}	
	let i = 0;
	for each (let [managed, prio, e] in enumerators) {
		while (e.hasMoreElements()) {
			let f = e.getNext().QueryInterface(Ci.nsIFile);
			if (f.leafName.search(/\.json$/i) != -1) {
				try {
					let o = loadPluginFromFile(f);

					if (p.indexOf(o.id) != -1) {
						continue;
					}

					o.priority += prio;
					o.managed = managed;
					
					++i;
					yield o;
				}
				catch (ex) {
					Components.utils.reportError("Failed to load " + f.leafName);
					Components.utils.reportError(ex);
				}
			}
		}
	}
	if (lastFilters && i != lastFilters) {
		log('dtaac:plugins: notify because of new numPlugins');
		lastFilters = i;
		observer.notify();
	}
}

/**
 * Enumerates plugins
 * @param all When true all plugins are enumerated, if false of missing then only active plugins
 * @return Generator over plugins
 */
function enumerate(all) {
	let enums = [[true, 1, EM_DIR.directoryEntries]];
	try {
		enums.push([false, 3, USER_DIR.directoryEntries]);
	}
	catch (ex) {
		// no op
	}
	let g = _enumerate(enums, all ? [] : uneval(Prefs.getCharPref('anticontainer.disabled_plugins')));
	for (let e in g) {
		yield e;
	}
}

/**
 * Installs a new Plugin from file
 * @param file File to load the new Plugin from, either String or nsIFile
 * @return The newly installed Plugin
 */
function installFromFile(file) {
	let p = loadPluginFromFile(file);
	let pd = USER_DIR.clone();
	let nn = idToFilename(p.id);
	file.copyTo(pd, nn);
	pd.append(nn);
	p.file = pd;
	observer.notify();
	return p;
}

/**
 * Installs a plugin as retrieved from the web
 * @param str String containing the source code of the plugin
 * @param updateURL [optional] The update URL of the plugin
 * @return The newly installed Plugin
 */
function installFromWeb(str, updateURL) {
	let p = JSON.decode(str);
	p.fromWeb = true;
	if (!p.updateURL && updateURL) {
		p.updateURL = updateURL;
	}
	str = JSON.encode(p);
	p = validatePlugin(p);
	
	let pf = USER_DIR.clone();
	pf.append(idToFilename(p.id));

	let cs = ConverterOutputStream(
		new FileOutputStream(pf, 0x02 | 0x08 | 0x20, -1, 0),
		null,
		0,
		null
	);
	cs.writeString(str);
	cs.close();
	observer.notify();
}

/**
 * Uninstalls a Plugin for a given id
 * @param id Id of the Plugin to uninstall
 * @return void
 */
function uninstallPlugin(id) {
	let pf = USER_DIR.clone();
	pf.append(idToFilename(id));
	if (!pf.exists()) {
		throw new Error("Cannot find plugin for id: " + id + ", tried: " + pf.path);
	}
	pf.remove(false);
	observer.notify();
}

const _store = {};

/**
 * Helper for webinstall: temp store a Plugin under a given id
 * @param id Id to store the Plugin under
 * @param plug Plugin to store (actually can be any object)
 * @return void
 */
function pushPlugin(id, plug) {
	_store[id] = plug;
}

/**
 * Helper for webinstall: get a temp stored Plugin again
 * @param id Id the Plugin is stored under
 * @return Stored Plugin
 */
function popPlugin(id) {
	if (!(id in _store)) {
		throw new Error("plugin not found!");
	}
	let rv = _store[id];
	delete _store[id];
	return rv;
}