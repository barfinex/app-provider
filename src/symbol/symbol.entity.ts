import {
    Entity,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ObjectIdColumn,
    ObjectId,
} from 'typeorm';

@Entity()
export class SymbolEntity {
    @ObjectIdColumn()
    id!: ObjectId; // ✅ Исправлено: ObjectId вместо number

    @Column()
    baseAsset!: string;

    @Column()
    quoteAsset!: string;

    @Column()
    symbol!: string;

    @Column()
    status!: string;

    @Column()
    connectorType!: string;

    @Column()
    marketType!: string;

    @UpdateDateColumn()
    updatedAt!: Date;

    @CreateDateColumn()
    createdAt!: Date;
}
