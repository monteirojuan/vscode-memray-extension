# Memray Profiler for VS Code

[![Marketplace](https://img.shields.io/visual-studio-marketplace/i/JuanMonteiro.memray-profiler?style=flat-square&label=VS%20Code)](https://marketplace.visualstudio.com/items?itemName=JuanMonteiro.memray-profiler)
[![Open VSX](https://img.shields.io/open-vsx/dt/JuanMonteiro/memray-profiler?style=flat-square&label=Open%20VSX)](https://open-vsx.org/extension/JuanMonteiro/memray-profiler)

Visualize alocações de memória, encontre leaks e otimize seu código Python usando [memray](https://github.com/bloomberg/memray) diretamente no VS Code.

> **Nota:** Memray suporta apenas **Linux** e **macOS**.

## ✨ Destaques

- **Um Clique:** Clique com o botão direito em um arquivo `.py` para iniciar o profiling.
- **Live Mode:** Gráficos de memória em tempo real e tabela dos maiores alocadores.
- **Flamegraphs Interativos:** Navegação visual com pulo direto para a linha do código-fonte.
- **Suporte Nativo:** Rastreia extensões C/C++ (NumPy, Pandas, PyTorch, etc).
- **Histórico:** Gerencie resultados anteriores através da barra lateral dedicada.

## 🛠️ Requisitos

- **OS:** Linux ou macOS.
- **Python:** 3.8+.
- **Memray:** `pip install memray` (recomendado no ambiente do projeto para habilitar o modo interativo).

## ⚙️ Configurações Principais

| Configuração | Descrição |
|--------------|-----------|
| `memray.nativeTracing` | Ativa rastreio de alocações C/C++. |
| `memray.outputDirectory` | Pasta onde os arquivos `.bin` serão salvos (padrão `.memray`). |
| `memray.liveUpdateIntervalSeconds` | Frequência de atualização do modo Live. |

---

Para detalhes sobre o design técnico, consulte o [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).


