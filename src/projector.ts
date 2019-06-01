import {
	Archive,
	ArchiveDir,
	ArchiveHdi,
	ArchiveTar,
	ArchiveTarGz,
	ArchiveZip
} from '@shockpkg/archive-files';
import {
	appendFile as fseAppendFile,
	close as fseClose,
	open as fseOpen,
	readFile as fseReadFile,
	remove as fseRemove,
	stat as fseStat,
	writeFile as fseWriteFile
} from 'fs-extra';

import {
	defaultNull,
	trimExtension
} from './util';

export interface IProjectorOptions {
	/**
	 * Player file or directory.
	 *
	 * @defaultValue null
	 */
	player?: string | null;

	/**
	 * Movie file.
	 *
	 * @defaultValue null
	 */
	movieFile?: string | null;

	/**
	 * Movie data.
	 *
	 * @defaultValue null
	 */
	movieData?: Buffer | null;

	/**
	 * Path to hdiutil binary.
	 *
	 * @defaultValue null
	 */
	pathToHdiutil?: string | null;
}

/**
 * Projector constructor.
 *
 * @param options Options object.
 */
export abstract class Projector extends Object {
	/**
	 * Player file or directory.
	 *
	 * @defaultValue null
	 */
	public player: string | null;

	/**
	 * Movie file.
	 *
	 * @defaultValue null
	 */
	public movieFile: string | null;

	/**
	 * Movie data.
	 *
	 * @defaultValue null
	 */
	public movieData: Buffer | null;

	/**
	 * Path to hdiutil binary.
	 *
	 * @defaultValue null
	 */
	public pathToHdiutil: string | null;

	constructor(options: IProjectorOptions = {}) {
		super();

		this.player = defaultNull(options.player);
		this.movieFile = defaultNull(options.movieFile);
		this.movieData = defaultNull(options.movieData);
		this.pathToHdiutil = defaultNull(options.pathToHdiutil);
	}

	/**
	 * Projector file extension.
	 */
	public abstract get projectorExtension(): string;

	/**
	 * The movie appended marker.
	 */
	public get movieAppendMarker() {
		return '563412FA';
	}

	/**
	 * Get movie data if any specified, from data or file.
	 *
	 * @return Movie data or null.
	 */
	public async getMovieData() {
		return this._dataFromBufferOrFile(
			this.movieData,
			this.movieFile
		);
	}

	/**
	 * Get the name of a projector trimming the extension, case insensitive.
	 *
	 * @param name Projector name.
	 * @return Projector name without extension.
	 */
	public getProjectorNameNoExtension(name: string) {
		return trimExtension(name, this.projectorExtension, true);
	}

	/**
	 * Get the player path, or throw.
	 *
	 * @return Player path.
	 */
	public getPlayerPath() {
		const player = this.player;
		if (!player) {
			throw new Error('Player must be set');
		}
		return player;
	}

	/**
	 * Get the player file or directory as an Archive instance.
	 *
	 * @param path File path.
	 * @return Archive instance.
	 */
	public async openAsArchive(path: string): Promise<Archive> {
		const stat = await fseStat(path);
		if (stat.isDirectory()) {
			return new ArchiveDir(path);
		}
		if (!stat.isFile()) {
			throw new Error(`Archive path not file or directory: ${path}`);
		}

		if (/\.zip$/i.test(path)) {
			return new ArchiveZip(path);
		}
		if (/\.dmg$/i.test(path)) {
			const r = new ArchiveHdi(path);
			const pathToHdiutil = this.pathToHdiutil;
			if (pathToHdiutil) {
				r.mounterMac.hdiutil = pathToHdiutil;
			}
			r.nobrowse = true;
			return r;
		}
		if (/\.tar$/i.test(path)) {
			return new ArchiveTar(path);
		}
		if (
			/\.tar\.gz$/i.test(path) ||
			/\.tgz$/i.test(path)
		) {
			return new ArchiveTarGz(path);
		}

		throw new Error(`Archive file type unknown: ${path}`);
	}

	/**
	 * Write out the projector.
	 *
	 * @param path Save path.
	 * @param name Save name.
	 */
	public async write(path: string, name: string) {
		await this._writePlayer(path, name);
		await this._modifyPlayer(path, name);
		await this._writeMovie(path, name);
	}

	/**
	 * Write the projector player.
	 *
	 * @param path Save path.
	 * @param name Save name.
	 */
	protected abstract async _writePlayer(path: string, name: string):
		Promise<void>;

	/**
	 * Modify the projector player.
	 *
	 * @param path Save path.
	 * @param name Save name.
	 */
	protected abstract async _modifyPlayer(path: string, name: string):
		Promise<void>;

	/**
	 * Write out the projector movie file.
	 *
	 * @param path Save path.
	 * @param name Save name.
	 */
	protected abstract async _writeMovie(path: string, name: string):
		Promise<void>;

	/**
	 * Append movie data to a file.
	 * Format string characters:
	 * - d: Movie data
	 * - m: Marker bytes
	 * - s: Size, LE
	 * - S: Size, BE
	 * - l: Size, LE, 64-bit
	 * - L: Size, BE, 64-bit
	 *
	 * @param file File to append to.
	 * @param data Movie data.
	 * @param format Format string.
	 */
	protected async _appendMovieData(
		file: string,
		data: Buffer,
		format: string
	) {
		const buffers: Buffer[] = [];
		for (const c of format) {
			switch (c) {
				case 'd': {
					buffers.push(data);
					break;
				}
				case 'm': {
					buffers.push(Buffer.from(this.movieAppendMarker, 'hex'));
					break;
				}
				case 's': {
					const b = Buffer.alloc(4);
					b.writeUInt32LE(data.length, 0);
					buffers.push(b);
					break;
				}
				case 'S': {
					const b = Buffer.alloc(4);
					b.writeUInt32BE(data.length, 0);
					buffers.push(b);
					break;
				}
				case 'l': {
					// 64-bit, just write 32-bit, SWF cannot be larger.
					const b = Buffer.alloc(8, 0);
					b.writeUInt32LE(data.length, 0);
					buffers.push(b);
					break;
				}
				case 'L': {
					// 64-bit, just write 32-bit, SWF cannot be larger.
					const b = Buffer.alloc(8, 0);
					b.writeUInt32BE(data.length, 4);
					buffers.push(b);
					break;
				}
				default: {
					throw new Error(`Unknown format string character: ${c}`);
				}
			}
		}

		const stat = await fseStat(file);
		if (!stat.isFile()) {
			throw new Error(`Path not a file: ${file}`);
		}

		const fd = await fseOpen(file, 'a');
		try {
			for (const b of buffers) {
				await fseAppendFile(fd, b);
			}
		}
		finally {
			await fseClose(fd);
		}
	}

	/**
	 * Get data from buffer or file.
	 *
	 * @param data Data buffer.
	 * @param file File path.
	 * @return Data buffer.
	 */
	protected async _dataFromBufferOrFile(
		data: Buffer | null,
		file: string | null
	) {
		if (data) {
			return data;
		}
		if (file) {
			return fseReadFile(file);
		}
		return null;
	}

	/**
	 * Get data from value or file.
	 *
	 * @param data Data value.
	 * @param file File path.
	 * @param newline Newline string.
	 * @param encoding String encoding.
	 * @return Data buffer.
	 */
	protected async _dataFromValueOrFile(
		data: string[] | string | Buffer | null,
		file: string | null,
		newline: string | null,
		encoding: BufferEncoding | null
	) {
		let str: string | null = null;
		if (typeof data === 'string') {
			str = data;
		}
		else if (Array.isArray(data)) {
			if (newline === null) {
				throw new Error('New line delimiter required');
			}
			str = data.join(newline);
		}
		else {
			return this._dataFromBufferOrFile(data, file);
		}
		if (!encoding) {
			throw new Error('String data encoding required');
		}
		return Buffer.from(str, encoding);
	}

	/**
	 * Maybe write file if data is not null.
	 *
	 * @param data Data to maybe write.
	 * @param path Output path.
	 * @param remove Optionally remove path first.
	 */
	protected async _maybeWriteFile(
		data: Buffer | null,
		path: string,
		remove = false
	) {
		if (!data) {
			return;
		}
		if (remove) {
			await fseRemove(path);
		}
		await fseWriteFile(path, data);
	}
}
