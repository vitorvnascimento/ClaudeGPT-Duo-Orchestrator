# Example: duo-demo

**English** · [Português](#português)

Landing page made in a real session with duo-orchestrator:

- **Claude Code (Opus 5.5)** as the brain wrote `index.html` (layout, text, and the "Como funciona" button).
- **Codex (GPT-6-Astra)** generated `assets/robo.png` with the image tool, at Claude's request through `duo delegate`.
- The bridge checked that only `assets/` changed and that the image is a valid 1254×1254 PNG.

Open `index.html` in the browser to see it.

## Recreate from scratch

```bash
cp -R examples/duo-demo ~/duo-demo && cd ~/duo-demo
rm assets/robo.png
git init && duo init --apply
# ative a confirmação de cobrança em .duo/config.json (veja o README principal)
```

Then, in Claude Code:

```text
/duo-delegate crie uma ilustração flat de um robô simpático acenando, azul e laranja, em assets/robo.png
```

---

## Português

Página inicial feita numa sessão real com o duo-orchestrator:

- **Claude Code (Opus 5.5)** como cérebro escreveu `index.html` (layout, textos e o botão "Como funciona").
- **Codex (GPT-6-Astra)** gerou `assets/robo.png` com a ferramenta de imagem, a pedido do Claude via `duo delegate`.
- A ponte conferiu que só `assets/` mudou e que a imagem é um PNG válido de 1254×1254.

Abra `index.html` no navegador para ver.

## Refazer do zero

```bash
cp -R examples/duo-demo ~/duo-demo && cd ~/duo-demo
rm assets/robo.png
git init && duo init --apply
# ative a confirmação de cobrança em .duo/config.json (veja o README principal)
```

Depois, no Claude Code:

```text
/duo-delegate crie uma ilustração flat de um robô simpático acenando, azul e laranja, em assets/robo.png
```
