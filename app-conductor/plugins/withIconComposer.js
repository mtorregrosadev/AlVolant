const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const appIconName = 'AppIcon';
const iconName = `${appIconName}.icon`;
const nativeRelativePath = path.join('AlVolant', iconName);

function copyIconComposerDocument(config) {
  const source = path.join(config.modRequest.projectRoot, 'assets', iconName);
  const destination = path.join(config.modRequest.platformProjectRoot, nativeRelativePath);
  const generatedStaticIcon = path.join(
    config.modRequest.platformProjectRoot,
    'AlVolant',
    'Images.xcassets',
    `${appIconName}.appiconset`,
  );

  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
  fs.rmSync(generatedStaticIcon, { recursive: true, force: true });
}

function configureIconComposer(project) {
  const target = project.getFirstTarget();
  const fileReferences = project.pbxFileReferenceSection();
  const exists = Object.values(fileReferences).some(
    (file) => file && file.path === nativeRelativePath,
  );

  if (!exists) {
    const group = project.findPBXGroupKey({ name: 'AlVolant' });
    const iconFile = project.addFile(
      nativeRelativePath,
      group,
      { lastKnownFileType: 'folder.iconcomposer' },
    );
    iconFile.uuid = project.generateUuid();
    iconFile.target = target.uuid;
    project.addToPbxBuildFileSection(iconFile);
    project.addToPbxResourcesBuildPhase(iconFile);
  }

  // The Icon Composer document is the app icon source; don't also compile the
  // generated static AppIcon.appiconset as the primary application icon.
  project.updateBuildProperty(
    'ASSETCATALOG_COMPILER_APPICON_NAME',
    appIconName,
    undefined,
    target.firstTarget.name,
  );
}

module.exports = function withIconComposer(config) {
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      copyIconComposerDocument(config);
      return config;
    },
  ]);

  return withXcodeProject(config, (config) => {
    configureIconComposer(config.modResults);
    return config;
  });
};
