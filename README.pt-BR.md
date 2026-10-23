# Paceline

Uma overlay discreta para acompanhar Claude Code e Codex sem registrar sessões na mão. Ela se recolhe na borda da tela e abre ao passar o mouse. Você pode escolher a borda, arrastar o painel, fixar aberto e recuperar pelo ícone perto do relógio (na barra de menus, no Mac) ou `Ctrl+Alt+V` (`Control+Option+V` no Mac).

## O que há na versão 0.4.0

- Consumo e reset informados pelas ferramentas, com idade da última leitura.
- Os mascotes acompanham seus agentes: ficam ocupados enquanto o Claude Code ou o Codex trabalha, comemoram quando termina, e uma notificação opcional avisa quando uma tarefa de um minuto ou mais acaba.
- Ritmo de cada janela: um marcador na barra mostra onde um ritmo uniforme deixaria você, e uma linha diz quando acaba ou quanto dá por dia até renovar.
- Histórico de quota em 24 horas/7 dias; os próprios logs do Codex preenchem o tempo em que o Paceline estava fechado.
- Projetos e sessões com tokens locais dos logs do Codex e dos transcripts do Claude Code (terminal e app desktop), separados da porcentagem da assinatura.
- Tema Paceline, Codex neutro ou Claude quente; o modo automático pode acompanhar a ferramenta em foco.
- Escala, transparência, atraso para recolher, provedores visíveis e avisos: quando restar 20%/5% (na mesma unidade dos cards), ritmo alto no limite semanal e "liberado" depois de uma janela apertada. Clicar na notificação abre o painel.
- Instalador Windows por usuário, versão portátil, imagem de disco universal para Mac (Apple Silicon e Intel) e atualização verificável por um repositório GitHub configurado.

**Os limites continuam sendo importantes:** os limites do Claude vêm da conta, usando o login do Claude Code. Sem esse login ou sem conexão, fica o último valor com sua idade e o card avisa. Tokens por projeto não são cobrança em reais nem uma medida exata de quanto resta na assinatura. O ritmo é uma estimativa pelo relógio da janela, não uma garantia.

## Leituras

Em **Limites**, cada período mostra quanto resta, quanto foi usado e quando renova. A barra sempre representa o restante; o tracinho nela marca onde um ritmo uniforme deixaria você agora. A linha "Ritmo" divide o uso até agora pelo tempo já passado da janela e projeta até a renovação, sem precisar de histórico. Os filtros do histórico escolhem leituras das últimas 24 horas ou 7 dias; não somam o consumo nem mudam os limites da conta. A barrinha recolhida fica vertical nas laterais e horizontal no topo/base.

Em **Projetos**, o número em destaque não conta a leitura de cache, que repete o mesmo contexto a custo baixo. A primeira leitura de um histórico grande de transcripts leva alguns minutos em segundo plano.

## Instalar ou executar

O build produz `release/Paceline-0.4.0-setup-x64.exe` e `release/Paceline-0.4.0-windows-x64.exe`. O instalador permite escolher uma pasta e usa `D:\projetos\Paceline-Desktop` por padrão quando `D:\projetos` existe. Os dados ficam em `paceline-data` ao lado do aplicativo. A desinstalação restaura a integração Claude e preserva histórico/configurações.

Não há certificado nem repositório público inventado: sem certificado real, o Windows pode mostrar aviso de editor desconhecido. O canal de atualização só funciona depois que um publicador real disponibilizar a release e seu manifesto.

### Mac

Abra o `Paceline-0.4.0-mac-universal.dmg` e arraste o Paceline para Aplicativos. Ele roda no macOS 12 ou mais novo e fica na barra de menus, sem ícone no Dock.

O app tem assinatura ad-hoc, mas não é notarizado pela Apple. Por isso, na primeira vez o macOS diz que não conseguiu verificar o desenvolvedor. Libere uma vez em **Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim**. No macOS 14 ou anterior, também dá para clicar com Control no app e escolher **Abrir**. Outra opção é rodar `xattr -dr com.apple.quarantine /Applications/Paceline.app`.

No Mac:

- Os dados ficam em `~/Library/Application Support/Paceline`.
- O login do Claude Code fica no Chaveiro, e o macOS pode pedir uma vez para permitir o acesso.
- O app acha `claude`, `codex` e `node` pelo `PATH` do seu shell, mesmo aberto pelo Finder.
- **Entrar no Claude** abre o `claude auth login` no seu app de terminal.

Para executar a partir do código, instale Node.js 22+ e as CLIs oficiais das IAs:

```powershell
cd paceline
npm ci
npm start
```

Entre no Codex com `codex login`. Para Claude, se o CLI não estiver logado, **Entrar no Claude** no card abre o `claude auth login` oficial numa janela; quando o login expira, **Renovar login** faz o mesmo. Depois disso os limites de 5h e semanal (e os semanais por modelo, quando o plano tem) aparecem sozinhos, mesmo quando você usa o Claude Code dentro do app desktop do Claude. A ponte do terminal fica em Configurações → Conexões, é opcional e precisa do **Node.js no PATH**. Os sistemas suportados são Windows 10/11 x64 e macOS 12 ou mais novo.

No desenvolvimento, os dados ficam em `.local/data`. `PACELINE_HOME` permite escolher uma pasta absoluta.

## Privacidade e atualização

Os projetos usam os contadores de tokens dos logs locais do Codex e dos transcripts do Claude Code. O programa não salva mensagens/conversas dessas fontes, só contadores, horários e identificadores em hash. Para os limites do Claude, ele lê o token de login que o Claude Code CLI guarda em `.credentials.json` (no Mac, no item `Claude Code-credentials` do Chaveiro) e o envia somente para `https://api.anthropic.com/api/oauth/usage`, no máximo a cada 4 minutos. O token fica só na memória e nunca é salvo nem enviado a outro lugar. O token de renovação não é usado; perto do vencimento, o app roda o `claude auth status` oficial. Esse endpoint não é documentado publicamente e pode mudar. Veja a [política de credenciais da Anthropic](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use). A pasta do projeto aparece localmente. O tema automático examina nome do processo/título da janela em memória e guarda apenas qual provedor foi reconhecido. No Mac, sem acesso aos títulos, ele reconhece os apps desktop e os terminais em que só um dos dois CLIs está rodando. O backup das configurações Claude pode conter valores que você já tinha colocado naquele arquivo. [Detalhes de privacidade](docs/PRIVACY.md).

Configure `owner/repo` de um publicador confiável nas opções de atualização. Buscar, baixar e instalar são ações explícitas; o download confere tamanho, origem e SHA-256/SHA-512. Hash não substitui confiança no publicador nem assinatura digital. [Instalação e atualização](docs/UPDATES.md).

Para testes: `npm test`. Para gerar instalador, portátil e manifesto: `npm run dist:win`. A imagem do Mac sai de `npm run dist:mac`, que só roda num Mac; os workflows do GitHub Actions a geram num runner macOS. A [documentação principal](README.md) e o [guia de publicação](docs/PUBLISHING.md) trazem os comandos completos.

Código sob [licença MIT](LICENSE). Projeto independente de OpenAI e Anthropic.
