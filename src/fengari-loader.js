'use strict';

const loader_utils = require('loader-utils');
const validateOptions = require('schema-utils');
const path = require('path');
const fs = require('fs');

const {
	luastring_eq,
	to_jsstring,
	to_luastring,
	lua: {
		LUA_ERRSYNTAX,
		lua_dump,
		lua_pop,
		lua_tojsstring,
		lua_tostring
	},
	lauxlib: {
		luaL_Buffer,
		luaL_addlstring,
		luaL_buffinit,
		luaL_loadbuffer,
		luaL_newstate,
		luaL_pushresult
	}
} = require('fengari');
const analyse_requires = require('./analyse_requires.js').analyse_requires;

const schema = {
	type: 'object',
	properties: {
		dependencies: {
			type: 'object',
			patternProperties: {
				'.*': { type: 'string' }
			}
		},
		strip: {
			type: 'boolean'
		}
	}
};

const exists = function(filename) {
	try {
		const s = fs.statSync(filename);
		return s.isFile() || s.isDirectory() ? s : false;
	} catch(e) {
		return false;
	}
}

const resolver = function(lua_dependencies, lua_name, resourcePath) {
	let dir = path.dirname(resourcePath);
	const ext = path.extname(resourcePath);
	const dep = lua_dependencies[lua_name];

	const resolve = function(dir, ext, dep) {
		let split = dep.split(".");
		let base = path.join(...split);

		// try path + ext
		let stat = exists(path.resolve(path.join(dir, base + ext)));
		if (stat !== false && stat.isFile()) {
			return path.join(dir, base + ext);
		}

		// try path + init.ext
		stat = exists(path.resolve(path.join(dir, base, "init" + ext)));
		if (stat !== false && stat.isFile()) {
			return path.join(dir, base, "init" + ext);
		}

		return ""
	}

	return resolve(dir, ext, dep) || resolve(path.dirname(dir), ext, dep) || dep;
}

exports.raw = true;
exports.default = function(source) {
	const options = loader_utils.getOptions(this) || {};
	validateOptions(schema, options, 'Fengari Loader');

	if (typeof source === 'string') {
		source = to_luastring(source);
	} else if (!(source instanceof Uint8Array)) {
		let buf = new Uint8Array(source.length);
		source.copy(buf);
		source = buf;
	}

	let L = luaL_newstate();
	if (luaL_loadbuffer(L, source, null, null) === LUA_ERRSYNTAX) {
		let msg = lua_tojsstring(L, -1);
		throw new SyntaxError(msg);
	}

	let s = 'var fengari_web = require("fengari-web");\n';
	let lua_dependencies = options.dependencies;
	let lua_dependencies_keys;
	if (lua_dependencies === void 0) {
		lua_dependencies = {};
		lua_dependencies_keys = analyse_requires(source);
		for (let i=0; i<lua_dependencies_keys.length; i++) {
			let lua_name = lua_dependencies_keys[i];
			/* skip the 'js' library (fengari-interop) as it's already included in fengari-web */
			if (lua_name === 'js') continue;
			/* if lua requires "foo" then look for webpack dependency "foo" */
			lua_dependencies[lua_name] = lua_name;
		}
	} else {
		lua_dependencies_keys = Object.keys(lua_dependencies);
	}
	if (lua_dependencies_keys.length > 0) {
		s +=
			'var lua = fengari_web.lua;\n' +
			'var lauxlib = fengari_web.lauxlib;\n' +
			'var L = fengari_web.L;\n' +
			'var push = fengari_web.interop.push;\n' +
			'lauxlib.luaL_getsubtable(L, lua.LUA_REGISTRYINDEX, lauxlib.LUA_PRELOAD_TABLE);\n';
		for (let i=0; i<lua_dependencies_keys.length; i++) {
			let lua_name = lua_dependencies_keys[i];
			let require_path = resolver(lua_dependencies, lua_name, this.resourcePath);
			this.addDependency(require_path);
			s +=
				'lua.lua_pushcfunction(L, function(L){push(L, require(' + JSON.stringify(require_path) +')); return 1;});\n' +
				'lua.lua_setfield(L, -2, fengari_web.to_luastring(' + JSON.stringify(lua_name) + '));\n';
		}
		s += 'lua.lua_pop(L, 1);\n';
	}
	let chunkname = '"@"+' + loader_utils.stringifyRequest(this, this.resourcePath);
	if (options.strip) {
		const writer = function(L, b, size, B) {
			luaL_addlstring(B, b, size);
			return 0;
		};
		let b = new luaL_Buffer();
		luaL_buffinit(L, b);
		if (lua_dump(L, writer, b, true) !== 0)
			throw new Error('unable to dump given function');
		luaL_pushresult(b);
		source = lua_tostring(L, -1);
		source = 'fengari_web.luastring_of(' + source.join(',') + ')';
		lua_pop(L, 1);
	} else {
		/* check if source is valid JS string */
		let stringsource = to_jsstring(source);
		if (luastring_eq(source, to_luastring(stringsource))) {
			source = JSON.stringify(stringsource);
		} else {
			source = 'fengari_web.luastring_of(' + source.join(',') + ')';
		}
	}
	return s + 'module.exports = fengari_web.load(' + source + ', ' + chunkname + ')' +
		/* call with require string */
		'.call(' + loader_utils.stringifyRequest(this, this.resource) + ');';
};
