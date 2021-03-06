var child_process = require('child_process');
var comparators = require('comparators').default;
var fs = require('fs');
var highland = require('highland');
var os = require('os');
var streams2 = require('../streams2/streams2');
var streams5 = require('../streams6/streams5');
var streams6 = require('../streams7/streams6');
var streams7 = require('../streams8/streams7');
var streams8 = require('../streams9/streams8');
var xmlbuilder = require('xmlbuilder');

var checkForGradleCache = streams8.checkForGradleCache;
var checkForMavenCache = streams8.checkForMavenCache;
var getAncestorFiles = streams7.getAncestorFiles;
var getComponentXML = streams6.getComponentXML;
var getExcludeFolderElement = streams6.getExcludeFolderElement;
var getFacetManagerXML = streams6.getFacetManagerXML;
var getFilePath = streams5.getFilePath;
var getIntellijXML = streams6.getIntellijXML;
var getLibraryJarPaths = streams8.getLibraryJarPaths;
var getLibraryOrderEntryElement = streams8.getLibraryOrderEntryElement;
var getLibraryRootElement = streams8.getLibraryRootElement;
var getModuleElement = streams7.getModuleElement;
var getModulesElement = streams7.getModulesElement;
var getModuleIMLPath = streams6.getModuleIMLPath;
var getSourceFolderElement = streams6.getSourceFolderElement;
var getWorkspaceModulesXML = streams7.getWorkspaceModulesXML;
var isDirectory = streams2.isDirectory;
var isFile = streams2.isFile;
var isFirstOccurrence = streams8.isFirstOccurrence;
var isSameLibraryDependency = streams8.isSameLibraryDependency;
var keyExistsInObject = highland.ncurry(2, streams8.keyExistsInObject);
var saveContent = streams6.saveContent;
var setLibraryName = streams8.setLibraryName;

var gradleCaches = streams8.gradleCaches;
var mavenCaches = streams8.mavenCaches;

var projectRepositories = [];

function createProjectObjectModels(coreDetails, moduleDetails) {
	var moduleVersions = coreDetails.reduce(setCoreBundleVersions, {});
	moduleVersions = moduleDetails.reduce(setModuleBundleVersions, moduleVersions);

	moduleDetails.forEach(highland.partial(fixLibraryDependencies, moduleVersions));
	moduleDetails.forEach(highland.partial(fixProjectDependencies, moduleVersions, false));

	var moduleStream = highland(moduleDetails);

	var mavenProjectStream = moduleStream.observe();
	var mavenAggregatorStream = moduleStream.observe();

	mavenProjectStream
		.map(getMavenProject)
		.each(saveContent);

	mavenAggregatorStream
		.pluck('modulePath')
		.collect()
		.map(getMavenAggregator)
		.each(saveContent);

	moduleStream.done(function() {});
};

function createProjectWorkspace(coreDetails, moduleDetails, pluginDetails) {
	if (pluginDetails) {
		pluginDetails.forEach(sortModuleAttributes);
	}

	var moduleVersions = coreDetails.reduce(setCoreBundleVersions, {});
	moduleVersions = moduleDetails.reduce(setModuleBundleVersions, moduleVersions);

	moduleDetails.forEach(highland.partial(fixLibraryDependencies, moduleVersions));
	moduleDetails.forEach(highland.partial(fixProjectDependencies, moduleVersions, true));
	moduleDetails.forEach(checkExportDependencies);

	coreDetails.forEach(sortModuleAttributes);
	moduleDetails.forEach(sortModuleAttributes);

	moduleDetails.forEach(checkForGradleCache);
	checkForGradleCache(os.homedir());
	checkForGradleCache('../liferay-binaries-cache-2017');

	moduleDetails.forEach(checkForMavenCache);
	checkForMavenCache(os.homedir());

	var moduleStream = highland(moduleDetails);
	var coreStream = highland(coreDetails);
	var pluginStream = highland(pluginDetails);

	var detailsStream = highland.merge([moduleStream, coreStream, pluginStream]);

	var moduleFilesStream = detailsStream.observe();
	var projectFileStream = detailsStream.observe();
	var libraryFilesStream = detailsStream.observe();
	var tagLibrariesStream = detailsStream.observe();

	moduleFilesStream
		.map(getModuleXML)
		.map(getIntellijXML)
		.each(saveContent);

	projectFileStream
		.sortBy(comparators.comparing('moduleName'))
		.map(getModuleElement)
		.collect()
		.map(getModulesElement)
		.map(getWorkspaceModulesXML)
		.map(getIntellijXML)
		.each(saveContent);

	libraryFilesStream = libraryFilesStream
		.pluck('libraryDependencies')
		.compact()
		.flatten()
		.uniqBy(isSameLibraryDependency);

	var coreLibraryFilesStream = libraryFilesStream.observe();

	coreLibraryFilesStream
		.where({'group': undefined})
		.map(getJarLibraryXML)
		.each(saveContent);

	libraryFilesStream
		.filter(keyExistsInObject('group'))
		.doto(setLibraryName)
		.map(getLibraryXML)
		.each(saveContent);

	detailsStream.done(function() {});
};

function checkExportDependencies(module) {
	var isTestModule = (module.moduleName.indexOf('test') != -1);

	if (isTestModule) {
		var isDevelopmentLibrary = function(dependency) {
			return dependency.name == 'development';
		};

		module.libraryDependencies = module.libraryDependencies || [];

		if (!module.libraryDependencies.some(isDevelopmentLibrary)) {
			var developmentDependency = {
				type: 'library',
				name: 'development',
				libraryName: 'development'
			};

			module.libraryDependencies.push(developmentDependency);
		}
	}

	if (module.moduleName.indexOf('gradle-') == 0) {
		var libraryDependency = {
			type: 'library',
			name: 'gradlew',
			libraryName: 'gradlew'
		};

		module.libraryDependencies.push(libraryDependency);
	}

	var isThirdPartyModule = (module.modulePath.indexOf('sdk') != -1) ||
		((module.modulePath.indexOf('core') != -1) && (module.moduleName.indexOf('osgi') != -1)) ||
		(module.modulePath.indexOf('third-party') != -1);

	var checkExportDependency = function(dependency) {
		if (isTestModule || isThirdPartyModule) {
			dependency.exported = true;
		}
	};

	if ('libraryDependencies' in module) {
		module.libraryDependencies.forEach(checkExportDependency);
	}

	if ('projectDependencies' in module) {
		module.projectDependencies.forEach(checkExportDependency);
	}
};

function fixLibraryDependencies(moduleVersions, module) {
	if (!('libraryDependencies' in module)) {
		module.libraryDependencies = [];
	}

	var ownVersion = moduleVersions[module.moduleName];

	for (var i = module.libraryDependencies.length - 1; i >= 0; i--) {
		var dependency = module.libraryDependencies[i];
		var dependencyGroup = dependency.group;

		if (!dependencyGroup || (dependencyGroup.indexOf('com.liferay') != 0)) {
			continue;
		}

		var dependencyName = dependency.name;

		if (!(dependencyName in moduleVersions)) {
			continue;
		}

		var moduleVersion = moduleVersions[dependencyName];

		if (module.hasInitJsp && moduleVersion.hasInitJsp) {
			dependency.hasInitJsp = true;
			continue;
		}

		module.libraryDependencies.splice(i, 1);

		var projectDependency = {
			type: 'project',
			name: moduleVersion.projectName,
			testScope: dependency.testScope
		};

		module.projectDependencies.push(projectDependency);
	}

	return module;
};

function fixProjectDependencies(moduleVersions, addAsLibrary, module) {
	if (!('projectDependencies' in module)) {
		return module;
	}

	if (!module.hasInitJsp) {
		return module;
	}

	for (var i = module.projectDependencies.length - 1; i >= 0; i--) {
		var dependency = module.projectDependencies[i];
		var dependencyName = dependency.name;

		if (!(dependencyName in moduleVersions)) {
			continue;
		}

		if (!addAsLibrary) {
			module.projectDependencies.splice(i, 1);
			continue;
		}

		var moduleVersion = moduleVersions[dependencyName];

		if (!moduleVersion.hasInitJsp) {
			continue;
		}

		module.projectDependencies.splice(i, 1);

		var libraryDependency = {
			type: 'library',
			group: 'com.liferay',
			name: moduleVersion.bundleName,
			version: dependency.version || moduleVersion.version,
			testScope: dependency.testScope,
			hasInitJsp: true
		};

		module.libraryDependencies.push(libraryDependency);
	}

	return module;
};

function getCoreLibraryOrderEntryElements(module) {
	if (!module.libraryDependencies) {
		return [];
	}

	return module.libraryDependencies
		.filter(highland.compose(highland.not, keyExistsInObject('group')))
		.map(setLibraryName)
		.map(highland.partial(getLibraryOrderEntryElement, module));
};

function getJarLibraryTableXML(library) {
	var libraryTableXML = [
		'<library name="' + library.name + '">',
		'<CLASSES>'
	];

	if (library.name == 'development') {
		var libraryPath = getFilePath('lib', 'development');
		var jarFiles = fs.readdirSync(libraryPath);

		Array.prototype.push.apply(
			libraryTableXML,
			jarFiles.filter(isDevelopmentLibrary)
				.map(highland.partial(getFilePath, libraryPath))
				.map(getLibraryRootElement));

		if (isFile('lib/portal/bnd.jar')) {
			libraryTableXML.push(getLibraryRootElement('lib/portal/bnd.jar'));
		}
	}
	else if (library.name == 'gradlew') {
		libraryTableXML.push(
			'<root url="file://$PROJECT_DIR$/.gradle/wrapper/dists" />');
	}
	else {
		libraryTableXML.push(
			'<root url="file://$PROJECT_DIR$/lib/' + library.name + '" />');
	}

	libraryTableXML.push(
		'</CLASSES>',
		'<JAVADOC />',
		'<SOURCES />');

	if (library.name == 'gradlew') {
		libraryTableXML.push('<jarDirectory url="file://$PROJECT_DIR$/.gradle/wrapper/dists" recursive="true" />');
	}
	else if (library.name != 'development') {
		libraryTableXML.push('<jarDirectory url="file://$PROJECT_DIR$/lib/' + library.name + '" recursive="false" />');
	}

	libraryTableXML.push('</library>');

	return libraryTableXML.join('\n');
};

function getJarLibraryXML(library) {
	var fileName = library.name + '.xml';

	var libraryTableComponent = {
		name: 'libraryTable',
		content: getJarLibraryTableXML(library)
	};

	return {
		name: '.idea/libraries/' + fileName,
		content: getComponentXML(libraryTableComponent)
	};
};

function getLibraryTableXML(library) {
	var libraryTableXML = [];

	libraryTableXML.push('<library name="' + library['libraryName'] + '">');
	libraryTableXML.push('<properties />');

	var binaryPaths = getLibraryJarPaths(library);

	if (binaryPaths.length > 0) {
		libraryTableXML.push('<CLASSES>');
		Array.prototype.push.apply(libraryTableXML, binaryPaths.map(getLibraryRootElement));
		libraryTableXML.push('</CLASSES>');
	}
	else {
		libraryTableXML.push('<CLASSES />');
	}

	libraryTableXML.push('<JAVADOC />');

	var sourcePaths = binaryPaths.map(getMavenSourcePath).filter(isFile);

	if (sourcePaths.length > 0) {
		libraryTableXML.push('<SOURCES>');
		Array.prototype.push.apply(libraryTableXML, sourcePaths.map(getLibraryRootElement));
		libraryTableXML.push('</SOURCES>');
	}
	else {
		libraryTableXML.push('<SOURCES />');
	}

	libraryTableXML.push('</library>');

	return libraryTableXML.join('\n');
};

function getLibraryXML(library) {
	var fileName = library['libraryName'].replace(/\W/g, '_') + '.xml';

	var libraryTableComponent = {
		name: 'libraryTable',
		content: getLibraryTableXML(library)
	};

	return {
		name: '.idea/libraries/' + fileName,
		content: getComponentXML(libraryTableComponent)
	};
};

function getMavenAggregator(modulePaths) {
	var project = {
		project: {
			'@xmlns': 'http://maven.apache.org/POM/4.0.0',
			'@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
			'@xsi:schemaLocation': 'http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd',
			modelVersion: '4.0.0',
			groupId: 'com.liferay.dependencies',
			artifactId: 'parent',
			version: '1.0.0-SNAPSHOT',
			packaging: 'pom',
			modules: {
				module: modulePaths
			}
		}
	};

	return {
		name: 'pom.xml',
		content: xmlbuilder.create(project).end({pretty: true})
	};
};

function getMavenDependencyElement(library) {
	var dependencyElement = {
		'groupId': library.group,
		'artifactId': library.name,
		'version': library.version
	};

	if ((library.group == 'org.jboss.shrinkwrap') && (library.name == 'shrinkwrap-depchain')) {
		dependencyElement['type'] = 'pom';
	}

	return dependencyElement;
};

function getMavenProject(module) {
	var dependencyObjects = {};

	if (module.libraryDependencies) {
		var libraryDependencies = module.libraryDependencies
			.filter(keyExistsInObject('group'))

		if (libraryDependencies.length > 0) {
			dependencyObjects = {
				dependency: libraryDependencies.map(getMavenDependencyElement)
			};
		}
	}

	var project = {
		project: {
			'@xmlns': 'http://maven.apache.org/POM/4.0.0',
			'@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
			'@xsi:schemaLocation': 'http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd',
			modelVersion: '4.0.0',
			groupId: 'com.liferay',
			artifactId: module.bundleSymbolicName,
			version: module.bundleVersion,
			packaging: 'pom',
			dependencies: dependencyObjects,
			repositories: {
				repository: getProjectRepositories().map(getProjectRepositoriesXMLEntry)
			}
		}
	};

	return {
		name: getFilePath(module.modulePath, 'pom.xml'),
		content: xmlbuilder.create(project).end({pretty: true})
	};
};

function getMavenSourcePath(mavenBinaryPath) {
	var pos = mavenBinaryPath.lastIndexOf('.');

	return mavenBinaryPath.substring(0, pos) + '-sources' + mavenBinaryPath.substring(pos);
};

function getModuleXML(module) {
	return {
		fileName: getModuleIMLPath(module),
		components: [
			{
				name: 'NewModuleRootManager',
				content: getNewModuleRootManagerXML(module)
			},
			{
				name: 'FacetManager',
				content: getFacetManagerXML(module)
			}
		]
	};
};

function getNewModuleRootManagerXML(module) {
	var newModuleRootManagerXML = [streams6.getNewModuleRootManagerXML(module)];

	newModuleRootManagerXML = newModuleRootManagerXML.concat(streams8.getModuleLibraryOrderEntryElements(module));
	newModuleRootManagerXML = newModuleRootManagerXML.concat(streams7.getProjectOrderEntryElements(module));
	newModuleRootManagerXML = newModuleRootManagerXML.concat(getCoreLibraryOrderEntryElements(module));

	return newModuleRootManagerXML.join('\n');
};

function getProjectRepositories() {
	if (projectRepositories.length > 0) {
		return projectRepositories;
	}

	var tempProjectRepositories = [];

	tempProjectRepositories.push({
		id: 'apache',
		name: 'Apache',
		scheme: 'http',
		path: 'repo.maven.apache.org/maven2',
		layout: 'default'
	});

	tempProjectRepositories.push({
		id: 'liferay-public',
		name: 'Liferay Public',
		scheme: 'http',
		path: 'repository.liferay.com/nexus/content/repositories/public',
		layout: 'default'
	});

	if (isDirectory('.git') || isFile('.git')) {
		var passwordBranch = child_process.execSync('git for-each-ref --format="%(refname)" refs/remotes/ | grep "/upstream[^/]*/7.0.x-private$" | cut -d"/" -f 3,4').toString().trim();

		if (passwordBranch) {
			var propertiesContent = child_process.execSync('git show ' + passwordBranch + ':working.dir.properties');

			var repositoryMetadata = getRepositoryMetadata(propertiesContent);

			tempProjectRepositories.push({
				id: 'liferay-private',
				name: 'Liferay Private',
				scheme: 'https',
				username: repositoryMetadata['username'],
				password: repositoryMetadata['password'],
				path: repositoryMetadata['url'],
				layout: 'default'
			});
		}
	}

	projectRepositories = tempProjectRepositories;

	return projectRepositories;
};

function getProjectRepositoriesXMLEntry(repository) {
	var repositoryBasicAuth = '';

	if (repository.username) {
		repositoryBasicAuth = encodeURIComponent(repository.username) + ':' + encodeURIComponent(repository.password) + '@';
	}

	var repositoryURL = repository.scheme + '://' + repositoryBasicAuth + repository.path;

	return {
		id: repository.id,
		name: repository.name,
		url: repositoryURL,
		layout: repository.layout
	};
};

function getRepositoryMetadata(propertiesContent) {
	var keyPrefix = 'build.repository.private.';
	var keySuffix = '[7.0.x-private]';

	return propertiesContent.toString()
		.split('\n')
		.map(function(x) {
			return x.trim();
		})
		.filter(function(x) {
			return (x.indexOf(keyPrefix) == 0) && (x.indexOf(keySuffix) != -1);
		})
		.reduce(function(accumulator, next) {
			var entry = next.split('=');
			var key = entry[0].trim();

			key = key.substring(keyPrefix.length, key.indexOf(keySuffix));

			accumulator[key] = entry[1].trim();
			return accumulator;
		}, {});
}

function isDevelopmentLibrary(libraryName) {
	return libraryName.indexOf('.jar') == libraryName.length - 4;
};

function setCoreBundleVersions(accumulator, module) {
	var bndPath = getFilePath(module.modulePath, 'bnd.bnd');
	var buildXmlPath = getFilePath(module.modulePath, 'build.xml');

	if (!isFile(bndPath)) {
		return accumulator;
	}

	var bndContent = fs.readFileSync(bndPath);

	var bundleNameRegex = /property name="manifest.bundle.symbolic.name" value="([^"\;]*)/g;
	var bundleVersionRegex = /Bundle-Version: ([^\r\n]+)/g;

	var bundleName = 'com.liferay.' + module.moduleName.replace(/-/g, '.');
	var matchResult = null;

	if (isFile(buildXmlPath)) {
		var buildXmlContent = fs.readFileSync(buildXmlPath);

		matchResult = bundleNameRegex.exec(buildXmlContent);

		if (!matchResult) {
			return accumulator;
		}

		bundleName = matchResult[1];
	}

	matchResult = bundleVersionRegex.exec(bndContent);

	if (!matchResult) {
		return accumulator;
	}

	var bundleVersion = matchResult[1];

	accumulator[bundleName] = {
		projectName: module.moduleName,
		version: bundleVersion
	};

	return accumulator;
};

function setModuleBundleVersions(accumulator, module) {
	accumulator[module.bundleSymbolicName] = {
		projectName: module.moduleName,
		version: module.bundleVersion,
		hasWebroot: module.webrootFolders.length > 0
	};

	accumulator[module.moduleName] = {
		bundleName: module.bundleSymbolicName,
		version: module.bundleVersion,
		hasWebroot: module.webrootFolders.length > 0
	};

	return accumulator;
};

function sortModuleAttributes(module) {
	module.sourceFolders.sort();
	module.resourceFolders.sort();
	module.testSourceFolders.sort();
	module.testResourceFolders.sort();

	if (module.libraryDependencies) {
		module.libraryDependencies.sort(comparators.comparing('name'));
	}

	if (module.projectDependencies) {
		module.projectDependencies.sort(comparators.comparing('name'));
	}

	return module;
};

exports.checkExportDependencies = checkExportDependencies;
exports.createProjectObjectModels = createProjectObjectModels;
exports.createProjectWorkspace = createProjectWorkspace;
exports.fixLibraryDependencies = fixLibraryDependencies;
exports.fixProjectDependencies = fixProjectDependencies;

exports.gradleCaches = gradleCaches;
exports.getJarLibraryXML = getJarLibraryXML;
exports.getLibraryXML = getLibraryXML;
exports.getMavenAggregator = getMavenAggregator;
exports.getMavenProject = getMavenProject;
exports.getModuleXML = getModuleXML;
exports.mavenCaches = mavenCaches;
exports.getProjectRepositories = getProjectRepositories;
exports.setCoreBundleVersions = setCoreBundleVersions;
exports.setModuleBundleVersions = setModuleBundleVersions;
exports.sortModuleAttributes = sortModuleAttributes;