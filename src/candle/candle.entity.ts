import { Column, Entity, PrimaryGeneratedColumn, ManyToOne, OneToMany, JoinColumn, OneToOne, ObjectId, ObjectIdColumn } from "typeorm";
import { CandleMetadataEntity } from './candleMetadata.entity';

@Entity()
export class CandleEntity {
    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    o: number;
    @Column()
    c: number;
    @Column()
    h: number;
    @Column()
    l: number;
    @Column()
    v: number;
    @Column()
    time: number;


    @ManyToOne(type => CandleMetadataEntity, candleMetadata => candleMetadata.candles, {
        orphanedRowAction: 'delete',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    candleMetadata: CandleMetadataEntity;

}