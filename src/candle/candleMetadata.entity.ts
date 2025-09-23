import { Column, Entity, PrimaryGeneratedColumn, ManyToOne, OneToMany, JoinColumn, OneToOne, ObjectId, ObjectIdColumn } from "typeorm";
import { CandleEntity } from './candle.entity';

//@Entity({ name: 'candle_data' })
@Entity()
export class CandleMetadataEntity {
    // @PrimaryGeneratedColumn()
    // id: number;
    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    connectorType: string;
    @Column()
    marketType: string;
    @Column()
    symbol: string;
    @Column()
    interval: string;
    @Column()
    validFrom: string;
    @Column()
    validTo: string;

    @OneToMany(type => CandleEntity, candle => candle.candleMetadata, { cascade: true, eager: true })
    candles: CandleEntity[];



    // @OneToOne(type => CandleEntity)
    // @JoinColumn({ name: 'id' })
    // candles: CandleEntity[];


    // @OneToMany(type => CandleEntity, candle => candle.candleData, { cascade: true })
    // candles: CandleEntity[];

    //@ManyToOne(() => Office, (office: Office) => office.equipment)
    // @JoinColumn({ name: 'office_id' })
    // candles: CandleEntity[];
}