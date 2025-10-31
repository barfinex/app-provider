import {
    Column,
    Entity,
    ObjectIdColumn,
    ObjectId,
    OneToMany,
} from "typeorm";
import { CandleEntity } from "./candle.entity";

@Entity()
export class CandleMetadataEntity {
    @ObjectIdColumn()
    id!: ObjectId;

    @Column()
    connectorType!: string;

    @Column()
    marketType!: string;

    @Column()
    symbol!: string;

    @Column()
    interval!: string;

    @Column()
    validFrom!: string;

    @Column()
    validTo!: string;

    @OneToMany(() => CandleEntity, (candle) => candle.candleMetadata, {
        cascade: true,
        eager: true,
    })
    candles!: CandleEntity[];
}
