const Command = require('../../structures/Command');
const jsChess = require('js-chess-engine');
const { createCanvas, loadImage } = require('canvas');
const moment = require('moment');
const { stripIndents } = require('common-tags');
const path = require('path');
const { verify, reactIfAble } = require('../../util/Util');
const { drawImageWithTint } = require('../../util/Canvas');
const { FAILURE_EMOJI_ID } = process.env;
const turnRegex = /^([A-H][1-8])(?: |, ?|-?>?)?([A-H][1-8])$/;
const pieces = ['pawn', 'rook', 'knight', 'king', 'queen', 'bishop'];
const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

module.exports = class ChessCommand extends Command {
	constructor(client) {
		super(client, {
			name: 'chess',
			group: 'games-mp',
			memberName: 'chess',
			description: 'Play a game of Chess with another user or the AI.',
			credit: [
				{
					name: 'Chessboard Image',
					url: 'https://chessboardimage.com/',
					reason: 'Piece Images'
				},
				{
					name: 'Wikimedia Commons',
					url: 'https://commons.wikimedia.org/wiki/Main_Page',
					reason: 'Board Image',
					reasonURL: 'https://commons.wikimedia.org/wiki/File:Chess_board_blank.svg'
				}
			],
			args: [
				{
					key: 'opponent',
					prompt: 'What user would you like to challenge? To play against AI, choose me.',
					type: 'user'
				}
			]
		});

		this.images = null;
	}

	async run(msg, { opponent }) {
		if (opponent.id === msg.author.id) return msg.reply('You may not play against yourself.');
		const current = this.client.games.get(msg.channel.id);
		if (current) return msg.reply(`Please wait until the current game of \`${current.name}\` is finished.`);
		this.client.games.set(msg.channel.id, { name: this.name });
		if (!this.images) await this.loadImages();
		try {
			if (!opponent.bot) {
				await msg.say(`${opponent}, do you accept this challenge?`);
				const verification = await verify(msg.channel, opponent);
				if (!verification) {
					this.client.games.delete(msg.channel.id);
					return msg.say('Looks like they declined...');
				}
			}
			const resumeGame = null;//await this.client.redis.get(`chess-${msg.author.id}`);
			let game;
			let whiteTime = 900000;
			let blackTime = 900000;
			let whitePlayer = msg.author;
			let blackPlayer = opponent;
			if (resumeGame) {
				await msg.reply('You have a saved game, do you want to resume it?');
				const verification = await verify(msg.channel, msg.author);
				if (verification) {
					const data = JSON.parse(resumeGame);
					game = new jsChess.Game(data.fen);
					whiteTime = data.whiteTime;
					blackTime = data.blackTime;
					whitePlayer = data.color === 'white' ? msg.author : opponent;
					blackPlayer = data.color === 'black' ? msg.author : opponent;
					await this.client.redis.del(`chess-${msg.author.id}`);
				} else {
					game = new jsChess.Game();
				}
			} else {
				game = new jsChess.Game();
			}
			let prevPieces = null;
			let saved = false;
			while (!game.exportJson().checkMate) {
				const gameState = game.exportJson();
				const user = gameState.turn === 'black' ? blackPlayer : whitePlayer;
				const time = gameState.turn === 'black' ? blackTime : whiteTime;
				if (user.bot) {
					prevPieces = Object.assign({}, game.exportJson().pieces);
					const now = new Date();
					game.aiMove(1);
					const timeTaken = new Date() - now;
					if (gameState.turn === 'black') blackTime -= timeTaken - 5000;
					if (gameState.turn === 'white') whiteTime -= timeTaken - 5000;
				} else {
					await msg.say(stripIndents`
						${user}, what move do you want to make (ex. A1A2)? Type \`end\` to forfeit.
						You can save your game by typing \`save\`.
						_You are ${gameState.check ? '**in check!**' : 'not in check.'}_

						**Time Remaining: ${moment.duration(time).format()}**
					`, { files: [{ attachment: this.displayBoard(gameState, prevPieces), name: 'chess.png' }] });
					prevPieces = Object.assign({}, game.exportJson().pieces);
					const moves = game.moves();
					const pickFilter = res => {
						if (![msg.author.id, opponent.id].includes(res.author.id)) return false;
						const choice = res.content.toUpperCase();
						if (choice === 'END') return true;
						if (choice === 'SAVE') return true;
						if (res.author.id !== user.id) return false;
						const move = choice.match(turnRegex);
						if (!move) return false;
						if (!moves[move[1]] || !moves[move[1]].includes(move[2])) {
							reactIfAble(res, res.author, FAILURE_EMOJI_ID, '❌');
							return false;
						}
						return true;
					};
					const now = new Date();
					const turn = await msg.channel.awaitMessages(pickFilter, {
						max: 1,
						time
					});
					if (!turn.size) {
						this.client.games.delete(msg.channel.id);
						return msg.say(`${user.id === msg.author.id ? opponent : msg.author} wins from timeout!`);
					}
					if (turn.first().content.toLowerCase() === 'end') break;
					if (turn.first().content.toLowerCase() === 'save') {
						const { author } = turn.first();
						const alreadySaved = null//await this.client.redis.get(`chess-${author.id}`);
						if (alreadySaved) {
							await msg.say('You already have a saved game, do you want to overwrite it?');
							const verification = await verify(msg.channel, author);
							if (!verification) continue; // eslint-disable-line max-depth
						}
						await this.client.redis.set(
							`chess-${author.id}`,
							this.exportGame(game, blackTime, whiteTime, whitePlayer.id === author.id ? 'white' : 'black')
						);
						saved = true;
						break;
					}
					const timeTaken = new Date() - now;
					if (gameState.turn === 'black') blackTime -= timeTaken - 5000;
					if (gameState.turn === 'white') whiteTime -= timeTaken - 5000;
					const choice = turn.first().content.toUpperCase().match(turnRegex);
					game.move(choice[1], choice[2]);
				}
			}
			this.client.games.delete(msg.channel.id);
			if (saved) {
				return msg.say(stripIndents`
					Game saved! Use ${this.usage(opponent.tag)} to resume it.
					You do not have to use the same opponent to resume the game.
					If you want to delete your saved game, use ${this.client.registry.commands.get('chess-delete').usage()}.
				`);
			}
			const gameState = game.exportJson();
			if (!gameState.checkMate) return msg.say('Game ended due to forfeit.');
			const winner = gameState.turn === 'black' ? whitePlayer : blackPlayer;
			return msg.say(`Checkmate! Congrats, ${winner}!`, {
				files: [{ attachment: this.displayBoard(gameState, prevPieces), name: 'chess.png' }]
			});
		} catch (err) {
			this.client.games.delete(msg.channel.id);
			throw err;
		}
	}

	displayBoard(gameState, prevPieces) {
		const canvas = createCanvas(this.images.board.width, this.images.board.height);
		const ctx = canvas.getContext('2d');
		ctx.drawImage(this.images.board, 0, 0);
		let w = 36;
		let h = 40;
		let row = 8;
		let col = 0;
		for (let i = 0; i < 64; i++) {
			const piece = gameState.pieces[`${cols[col]}${row}`];
			const prevGamePiece = prevPieces ? prevPieces[`${cols[col]}${row}`] : null;
			if (piece) {
				const parsed = this.pickImage(piece);
				if (prevPieces && (!prevGamePiece || piece !== prevGamePiece)) {
					drawImageWithTint(ctx, this.images[parsed.color][parsed.name], 'green', w, h, 52, 52);
				} else {
					ctx.drawImage(this.images[parsed.color][parsed.name], w, h, 52, 52);
				}
			} else if (prevGamePiece) {
				ctx.fillStyle = 'green';
				ctx.globalAlpha = 0.5;
				ctx.fillRect(w, h, 52, 52);
				ctx.globalAlpha = 1;
			}
			w += 52 + 2;
			col += 1;
			if (col % 8 === 0 && col !== 0) {
				w = 36;
				col = 0;
				h += 52 + 2;
				row -= 1;
			}
		}
		return canvas.toBuffer();
	}

	async loadImages() {
		const images = { black: {}, white: {} };
		images.board = await loadImage(path.join(__dirname, '..', '..', 'assets', 'images', 'chess', 'board.png'));
		for (const piece of pieces) {
			const blk = `black-${piece}.png`;
			images.black[piece] = await loadImage(path.join(__dirname, '..', '..', 'assets', 'images', 'chess', blk));
			const whi = `white-${piece}.png`;
			images.white[piece] = await loadImage(path.join(__dirname, '..', '..', 'assets', 'images', 'chess', whi));
		}
		this.images = images;
		return images;
	}

	pickImage(piece) {
		let name;
		let color;
		switch (piece) {
			case 'p':
				name = 'pawn';
				color = 'black';
				break;
			case 'n':
				name = 'knight';
				color = 'black';
				break;
			case 'b':
				name = 'bishop';
				color = 'black';
				break;
			case 'r':
				name = 'rook';
				color = 'black';
				break;
			case 'q':
				name = 'queen';
				color = 'black';
				break;
			case 'k':
				name = 'king';
				color = 'black';
				break;
			case 'P':
				name = 'pawn';
				color = 'white';
				break;
			case 'N':
				name = 'knight';
				color = 'white';
				break;
			case 'B':
				name = 'bishop';
				color = 'white';
				break;
			case 'R':
				name = 'rook';
				color = 'white';
				break;
			case 'Q':
				name = 'queen';
				color = 'white';
				break;
			case 'K':
				name = 'king';
				color = 'white';
				break;
		}
		return { name, color };
	}

	exportGame(game, blackTime, whiteTime, playerColor) {
		return JSON.stringify({
			fen: game.exportFEN(),
			blackTime,
			whiteTime,
			color: playerColor
		});
	}
};
