#!/usr/bin/env python3
"""Build a release: compile, package releases/checklist-bridge-<version>.vsix, write latest.json.

The .vsix layout matches what Microsoft's `vsce package` produces, so the same file can be
uploaded to the VS Code Marketplace or installed directly.

Usage: python3 scripts/release.py ["one-line release note"]
Then commit and push; installed extensions pick the update up from the repo's main branch.
"""
import hashlib, json, os, shutil, subprocess, sys, zipfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
pkg = json.load(open('package.json'))
version = pkg['version']
note = sys.argv[1] if len(sys.argv) > 1 else ''

# Full types come from `npm install`; without them, build against the bundled stub.
cfg = '.' if os.path.exists('node_modules/@types/vscode') else 'tsconfig.offline.json'
tsc = ['npx', '--no-install', 'tsc'] if os.path.exists('node_modules/.bin/tsc') else ['tsc']
shutil.rmtree('dist', ignore_errors=True)
subprocess.run(tsc + ['-p', cfg], check=True)

# Files that ship, mapped to their path inside the package (vsce's naming).
files = {
    'package.json': 'extension/package.json',
    'README.md': 'extension/readme.md',
    'CHANGELOG.md': 'extension/changelog.md',
    'LICENSE': 'extension/LICENSE.txt',
}
for d in ['dist', 'media']:
    for root, dirs, names in os.walk(d):
        dirs.sort()
        for name in sorted(names):
            if d == 'dist' and not name.endswith('.js'):
                continue
            src = os.path.join(root, name)
            files[src] = 'extension/' + src.replace(os.sep, '/')

repo = pkg['repository']['url']
X = lambda s: escape(str(s), {'"': '&quot;'})
props = [
    ('Microsoft.VisualStudio.Code.Engine', pkg['engines']['vscode']),
    ('Microsoft.VisualStudio.Code.ExtensionDependencies', ''),
    ('Microsoft.VisualStudio.Code.ExtensionPack', ''),
    ('Microsoft.VisualStudio.Code.ExtensionKind', 'workspace'),
    ('Microsoft.VisualStudio.Code.LocalizedLanguages', ''),
    ('Microsoft.VisualStudio.Code.EnabledApiProposals', ''),
    ('Microsoft.VisualStudio.Code.ExecutesCode', 'true'),
    ('Microsoft.VisualStudio.Services.Links.Source', repo),
    ('Microsoft.VisualStudio.Services.Links.Getstarted', repo),
    ('Microsoft.VisualStudio.Services.Links.GitHub', repo),
    ('Microsoft.VisualStudio.Services.Links.Support', pkg['bugs']['url']),
    ('Microsoft.VisualStudio.Services.Links.Learn', pkg['homepage']),
    ('Microsoft.VisualStudio.Services.Branding.Color', pkg['galleryBanner']['color']),
    ('Microsoft.VisualStudio.Services.Branding.Theme', pkg['galleryBanner']['theme']),
    ('Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown', 'true'),
    ('Microsoft.VisualStudio.Services.Content.Pricing', 'Free'),
]
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="{X(pkg['name'])}" Version="{X(version)}" Publisher="{X(pkg['publisher'])}" />
		<DisplayName>{X(pkg['displayName'])}</DisplayName>
		<Description xml:space="preserve">{X(pkg['description'])}</Description>
		<Tags>{X(','.join(pkg.get('keywords', [])))}</Tags>
		<Categories>{X(','.join(pkg['categories']))}</Categories>
		<GalleryFlags>Public</GalleryFlags>
		<Badges></Badges>
		<Properties>
{chr(10).join(f'			<Property Id="{k}" Value="{X(v)}" />' for k, v in props)}
		</Properties>
		<License>extension/LICENSE.txt</License>
		<Icon>extension/{X(pkg['icon'])}</Icon>
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
	</Installation>
	<Dependencies/>
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{X(pkg['icon'])}" Addressable="true" />
	</Assets>
</PackageManifest>
'''

mime = {'.json': 'application/json', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
        '.png': 'image/png', '.md': 'text/markdown', '.txt': 'text/plain', '.vsixmanifest': 'text/xml'}
exts = sorted({os.path.splitext(p)[1].lower() for p in files.values()} | {'.vsixmanifest'})
missing = [e for e in exts if e not in mime]
if missing:
    sys.exit(f'No content type for {missing}; add it to `mime` in release.py')
types = ('<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
         + ''.join(f'<Default Extension="{e}" ContentType="{mime[e]}"/>' for e in exts) + '</Types>')

os.makedirs('releases', exist_ok=True)
rel = f'releases/checklist-bridge-{version}.vsix'
with zipfile.ZipFile(rel, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('extension.vsixmanifest', manifest)
    z.writestr('[Content_Types].xml', types)
    for src, dst in files.items():
        z.write(src, dst)

# Stable name for the README's download link.
shutil.copyfile(rel, 'releases/checklist-bridge-latest.vsix')
sha = hashlib.sha256(open(rel, 'rb').read()).hexdigest()
json.dump({'version': version, 'vsix': rel, 'sha256': sha, 'notes': note}, open('latest.json', 'w'), indent=2)
print(f'{rel}\nsha256 {sha}\nlatest.json -> {version}')
