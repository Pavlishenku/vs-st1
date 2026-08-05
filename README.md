# VS ST1 Demo

Coloration syntaxique pour les fichiers ST1 (`.st1`) dans Visual Studio Code.

## Compiler

```powershell
npm install
npm run compile    # build (esbuild) -> dist/
npm test           # tests unitaires
npm run package    # produit vs-st1-<version>.vsix
```

## Structure du dépôt

- `catalog/` — catalogue des commandes ST1, source de vérité ; `npm run gen` en dérive la grammaire et les snippets ;
- `syntaxes/`, `snippets/` — fichiers générés, ne pas éditer à la main ;
- `shared/` — parseur et analyse ST1, communs aux deux briques suivantes ;
- `server/` — serveur de langage (LSP), lancé par l'extension ;
- `src/` — extension VS Code (commandes, panneaux) ;
- `media/`, `icons/` — ressources des webviews et icônes ;
- `test/` — tests unitaires (`npm test`).

## Licence

MIT pour l'extension. Le logiciel ST1 et son manuel restent la propriété du
CEREMA-ITM et ne sont pas redistribués.
