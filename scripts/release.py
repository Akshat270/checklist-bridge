#!/usr/bin/env python3
"""Build a release: compile, package releases/checklist-bridge-<version>.vsix, write latest.json.

Usage: python3 scripts/release.py ["one-line release note"]
Then commit and push; installed extensions pick the update up from the repo's main branch.
"""
import hashlib, json, os, subprocess, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
pkg = json.load(open('package.json'))
version = pkg['version']
note = sys.argv[1] if len(sys.argv) > 1 else ''

subprocess.run(['npx', '--no-install', 'tsc', '-p', '.'] if os.path.exists('node_modules/.bin/tsc') else ['tsc', '-p', '.'], check=True)

manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg['name']}" Version="{version}" Publisher="{pkg['publisher']}" />
    <DisplayName>{pkg['displayName']}</DisplayName>
    <Description xml:space="preserve">{pkg['description']}</Description>
    <Tags>claude,mcp,checklist</Tags>
    <Categories>AI,Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{pkg['engines']['vscode']}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
    <License>extension/LICENSE</License>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
  </Assets>
</PackageManifest>
'''
types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".css" ContentType="text/css"/><Default Extension=".svg" ContentType="image/svg+xml"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".vsixmanifest" ContentType="text/xml"/><Default Extension="" ContentType="text/plain"/></Types>
'''

os.makedirs('releases', exist_ok=True)
rel = f'releases/checklist-bridge-{version}.vsix'
with zipfile.ZipFile(rel, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('extension.vsixmanifest', manifest)
    for f in ['package.json', 'README.md', 'LICENSE']:
        z.write(f, f'extension/{f}')
    for d in ['dist', 'media']:
        for name in sorted(os.listdir(d)):
            if d == 'dist' and not name.endswith('.js'):
                continue
            z.write(os.path.join(d, name), f'extension/{d}/{name}')

sha = hashlib.sha256(open(rel, 'rb').read()).hexdigest()
json.dump({'version': version, 'vsix': rel, 'sha256': sha, 'notes': note}, open('latest.json', 'w'), indent=2)
print(f'{rel}\nsha256 {sha}\nlatest.json -> {version}')
