# Paceline desktop

## Intenção

Um instrumento de mesa: discreto em repouso, legível em um olhar, útil sem interromper o trabalho. O painel usa carvão levemente esverdeado, linhas finas e barras de disponibilidade. O símbolo original reúne três pequenas colunas inclinadas, sugerindo capacidade e um registro em andamento.

## Dimensões e comportamento

- Janela recolhida: 238 × 48 px no topo/base; 76 × 238 px nas laterais, com texto em pé. Inclui 8 px transparentes de cada lado.
- Janela expandida: 416 × 560 px, incluindo as mesmas margens.
- Mouse sobre a aba abre o painel. Sair inicia espera configurável de 200 a 5.000 ms (padrão: 450 ms); foco de teclado, visão de detalhes aberta ou fixação impedem o fechamento automático.
- Escape fecha configurações primeiro; depois desafixa e recolhe o painel.
- A posição (topo, base, esquerda, direita) é gerenciada pelo processo principal; o renderer solicita o tamanho real pela API de preload.

## Linguagem visual

| Token | Valor | Uso |
|---|---|---|
| Fundo | `#171916` | Carcaça |
| Superfície | `#1f221e` | Leituras de cada provedor |
| Texto | `#f0f1e8` | Informação principal |
| Texto secundário | `#a3aa99` | Contexto |
| Mint | `#b9edac` | Codex e estados ativos |
| Âmbar | `#e7c384` | Claude e leituras antigas |
| Atenção | `#ec9b8c` | 15% ou menos disponível |

Bahnschrift dá o caráter de instrumento aos títulos e números; Segoe UI mantém a leitura do restante. São fontes locais, sem downloads, chamadas de rede ou dependências de fonte. Em outros sistemas o navegador usa sans-serif local. Movimentos limitam-se a cor e preenchimento das barras e respeitam `prefers-reduced-motion`.

## Semântica das leituras

As barras sempre representam o **restante**: `100 − percentual utilizado`, limitado a 0–100. Cada limite mostra usado, restante e renovação juntos; nenhum seletor inverte a leitura. Períodos são identificados pelos dados do provedor. A aba recolhida usa o menor saldo e seu tooltip identifica a leitura. Dados antigos ou limites vencidos não aparecem como saldo atual na aba recolhida. Isso não representa tokens exatos, cobrança ou quantidade garantida de trabalho.

Não existem números de produção inventados. Sem leitura, o painel mostra travessão, contexto e ação de conexão. Leituras com mais de cinco minutos ficam identificadas como antigas. A passagem do horário de reset não zera os dados: o painel aguarda a próxima leitura oficial. A origem e o horário completo estão disponíveis no tooltip da atualização.

## Prévia

Abrir `src/renderer/index.html?demo` em uma viewport de 416 × 560 mostra dados fictícios, com selo DEMO e aviso no rodapé. Sem a API Electron e sem esse parâmetro, nenhuma métrica é simulada. O modo de demonstração não autentica contas.

## Acessibilidade e segurança

Botões têm nomes acessíveis, estado de fixação e seleção exposto, foco visível e operação de teclado. Medidores incluem disponibilidade e consumo em seus rótulos. Mensagens transitórias usam `role="status"`. Dados dos provedores são inseridos como texto; o renderer não injeta HTML recebido. A política de conteúdo bloqueia rede, scripts inline e objetos. O renderer usa somente a API explicitamente exposta pelo preload.

## Visões e personalização — 0.3

**Limites** mostra as janelas oficiais da assinatura. **Histórico** mostra as leituras coletadas pelo próprio Paceline nas últimas 24 horas ou sete dias. A linha não liga pontos através de resets; a primeira leitura isolada é representada por um ponto, sem inventar uma tendência. Uma previsão disponível vem acompanhada de linguagem de estimativa. Sem dados, a tela explica que o histórico começa com a coleta.

**Projetos** organiza métricas locais por projeto ou sessão. O texto separa explicitamente esses tokens observados dos limites da conta, do faturamento e do uso em outros dispositivos. O Claude vem dos transcripts do Claude Code, cada resposta contada uma vez; o número em destaque não conta a leitura de cache. As visões recarregam ao abrir, a cada mudança de dados informada pelo processo principal e em intervalos de 30 segundos enquanto abertas.

O tema **Automático** acompanha o último Codex ou Claude reconhecido em foco, sem copiar seus logotipos. Codex usa preto, cinzas neutros e branco; Claude usa creme e terracota. Ao mudar para outro programa, o último tema permanece. O contexto ativo ordena primeiro o provedor correspondente. Essa detecção pode ser desativada, e qualquer tema pode ser escolhido manualmente. Não depende de ler o conteúdo da janela ou armazenar seu título.

As configurações oferecem escala 80–130%, opacidade 50–100%, tempo de recolhimento, provedores visíveis, níveis de aviso em % restante, aviso de reset e localização. Escala e opacidade são aplicadas pelo processo principal, evitando duplicar zoom no renderer. O título permite arrastar a janela por `moveOverlay({x, y, phase})`; botões continuam independentes da área de arraste.

Conexões distinguem ausência de ferramenta e login necessário; no Claude, o botão abre o login oficial e a ponte do terminal fica como opção avançada. O botão de remoção usa a API explícita de remover a integração. Atualizações requerem repositório informado como `autor/repositório`; o painel oferece buscar, baixar e reiniciar para instalar conforme o estado real retornado.

## Roteiro de smoke da interface

1. Sem leituras: verificar travessões, onboarding e ausência de métricas simuladas. Claude `integration.installed=true` deve indicar configuração concluída e necessidade de nova sessão.
2. Alterar contexto para Claude e Codex: paleta e primeira posição acompanham o provedor; foco de teclado de um botão deve permanecer após reordenar. Desligar `followActiveApp` restaura a ordem configurada e permite tema manual.
3. Conferir usado/restante simultâneos, barras sempre de restante, rótulos ARIA e aba recolhida; esconder um provedor. A interface deve impedir esconder os dois.
4. Configurações: sliders, bordas, níveis de aviso em % restante, aviso de reset, início com Windows, login do Claude e a ponte opcional do terminal.
5. Histórico: testar vazio, ponto único, várias leituras, queda por reset, oscilação de 1 s no reset informado (mesma janela), ritmo cedo demais, troca rápida de intervalo e nova leitura com a tela aberta.
6. Projetos: testar vazio, projetos/sessões, contagem parcial, nomes extensos, atualização automática e ausência de confusão entre tokens locais e quota da conta.
7. Atualizador: testar não configurado, procurando, disponível, progresso, download concluído e erro; somente a ação válida para o estado aparece.
8. Teclado: Tab, foco visível e Escape; auto-hide deve respeitar atraso e fixação. Arraste deve preservar cliques dos controles. Verificar as duas dimensões em escalas mínima e máxima.

## Ritmo e avisos — 0.4

Cada barra de limite ganha um tracinho onde um ritmo uniforme deixaria o usuário agora; o preenchimento à esquerda dele indica consumo adiantado. Abaixo do horário de renovação, uma linha curta resume o ritmo da própria janela (uso até agora dividido pelo tempo já passado): quando acaba, se for antes da renovação; em janelas de vários dias, quanto dá por dia até renovar; senão, a porcentagem prevista no reset. Ela some nos primeiros minutos da janela e em leituras antigas. O Histórico repete a mesma conta e acrescenta o uso de hoje em janelas semanais.

Os avisos usam a mesma unidade dos cards: botões "Avisar quando restar" 30/20/10/5%. O aviso de renovação só aparece depois de uma janela que chegou ao nível de alerta, e o de ritmo alto só para limites semanais que acabariam pelo menos 12 horas antes de renovar. Clicar na notificação abre o painel.

Os mascotes acompanham os agentes: enquanto o Claude Code ou o Codex roda um turno, o mascote dele fica "trabalhando" (Claude anda no lugar e olha em volta; o `>` do Codex digita); ao terminar, comemora por alguns segundos. A atividade tem prioridade sobre o humor da cota. Um turno de um minuto ou mais pode gerar a notificação "terminou", que tem chave própria nas configurações.

Quando o login do Claude expira, a última leitura continua visível com uma linha explicando o motivo, e a ação do card abre o login oficial.
