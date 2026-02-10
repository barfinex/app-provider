// src/inspector/inspector.repository.ts
import { Injectable } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { EventSinkRepository } from '../questdb/event-sink/event-sink.repository';

export interface InspectorEntity {
    name: string;
    options: any;
    status: 'active' | 'deleted';
    createdAt: number;
    updatedAt: number;
    deletedAt?: number | null;
}

@Injectable()
export class InspectorRepository {
    constructor(
        private readonly reader: QuestDBQueryService,
        private readonly events: EventSinkRepository,
    ) { }

    // --------------------------------------
    // ESCAPE
    // --------------------------------------
    private esc(str: string): string {
        return str.replace(/'/g, "''");
    }

    // --------------------------------------
    // MAP ROW → ENTITY
    // --------------------------------------
    private rowToEntity(row: any): InspectorEntity {
        return {
            name: row.name,
            options: JSON.parse(row.options),
            status: row.status ?? 'active',
            createdAt: Number(row.createdAt),
            updatedAt: Number(row.updatedAt),
            deletedAt: row.deletedAt ? Number(row.deletedAt) : null,
        };
    }

    // --------------------------------------
    // FIND ALL (only active)
    // --------------------------------------
    async find(): Promise<InspectorEntity[]> {
        const rows = await this.reader.queryAsObjects(`
            SELECT *
            FROM inspectors
            WHERE status='active'
            ORDER BY name
        `);

        return rows.map(x => this.rowToEntity(x));
    }

    // --------------------------------------
    // FIND ONE
    // --------------------------------------
    async findOne(options: { where: { name?: string }, withDeleted?: boolean }): Promise<InspectorEntity | null> {
        const { name } = options.where;
        if (!name) return null;

        let sql = `
            SELECT *
            FROM inspectors
            WHERE name='${this.esc(name)}'
        `;

        if (!options.withDeleted) sql += ` AND status='active'`;

        sql += ` LIMIT 1`;

        const row = await this.reader.queryOne(sql);
        return row ? this.rowToEntity(row) : null;
    }

    // --------------------------------------
    // CREATE (local)
    // --------------------------------------
    create(data: Partial<InspectorEntity>): InspectorEntity {
        const now = Date.now();
        return {
            name: data.name!,
            options: data.options ?? {},
            status: 'active',
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        };
    }

    // --------------------------------------
    // SAVE
    // --------------------------------------
    async save(entity: InspectorEntity): Promise<InspectorEntity> {
        const exists = await this.findOne({ where: { name: entity.name }, withDeleted: true });

        if (exists) {
            await this.update(entity.name, {
                options: entity.options,
                updatedAt: Date.now(),
            });
        } else {
            await this.insert(entity);
        }

        return entity;
    }

    // --------------------------------------
    // INSERT
    // --------------------------------------
    async insert(entity: InspectorEntity): Promise<void> {
        await this.reader.query(`
            INSERT INTO inspectors (name, options, status, createdAt, updatedAt, deletedAt)
            VALUES (
                '${this.esc(entity.name)}',
                '${this.esc(JSON.stringify(entity.options))}',
                'active',
                ${entity.createdAt},
                ${entity.updatedAt},
                null
            )
        `);

        this.events.emit('inspector.insert', {
            category: 'inspector',
            action: 'insert',
            timestamp: Date.now(),
            data: { name: entity.name },
        });
    }

    // --------------------------------------
    // UPDATE
    // --------------------------------------
    async update(name: string, patch: Partial<InspectorEntity>): Promise<void> {
        const sets = Object.entries(patch)
            .map(([k, v]) => {
                if (v === undefined) return null;

                if (k === 'options') {
                    return `${k}='${this.esc(JSON.stringify(v))}'`;
                }
                if (typeof v === 'string') {
                    return `${k}='${this.esc(v)}'`;
                }

                return `${k}=${v}`;
            })
            .filter(Boolean)
            .join(',');

        await this.reader.query(`
            UPDATE inspectors
            SET ${sets}
            WHERE name='${this.esc(name)}'
        `);

        this.events.emit('inspector.update', {
            category: 'inspector',
            action: 'update',
            timestamp: Date.now(),
            data: { name, patch },
        });
    }

    // --------------------------------------
    // SOFT DELETE
    // --------------------------------------
    async delete(name: string): Promise<void> {
        const escaped = this.esc(name);

        await this.reader.query(`
            UPDATE inspectors
            SET status='deleted',
                deletedAt=now(),
                updatedAt=now()
            WHERE name='${escaped}'
        `);

        this.events.emit('inspector.delete', {
            category: 'inspector',
            action: 'delete',
            timestamp: Date.now(),
            data: { name },
        });
    }

    // --------------------------------------
    // Helpers
    // --------------------------------------
    async getAll() {
        return this.find();
    }

    async getByName(name: string, withDeleted = false) {
        return this.findOne({ where: { name }, withDeleted });
    }
}
